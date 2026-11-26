import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCommitContextReader,
  createEvidenceCommitter,
  createWithActor,
  createWorkOpener,
  type EvidenceCommitContext,
  type EvidenceCommitInput,
  type ReceiptSigner,
  type WithActor,
} from "../../server/database/index.ts";
import {
  type SignatureEnvelope,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";

// DAN-815 parts a1 and a2, plan of attack ductura/server#119 parts C5, D, E
// and F1: the commit context and the commit transaction over real PostgreSQL
// with RLS, through a ductus_app login as in
// production. Every institution, person, course, token, key and text is
// random and synthetic; the login exists only while this file runs. The
// segment bytes are not checked here (that is part b): the descriptor is
// built as the route builds it, and the snapshot hashes to its final hash.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_commit_app";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");

const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  ana: randomUUID(),
  dora: randomUUID(),
  eva: randomUUID(),
  iva: randomUUID(),
  mia: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  domainA: randomUUID(),
};
const students = ["ana", "dora", "eva", "iva", "mia"] as const;
type Student = (typeof students)[number];
const token: Record<Student | "vesna" | "closed", string> = Object.fromEntries(
  [...students, "vesna", "closed"].map((name) => [name, randomBytes(32).toString("base64url")]),
) as never;

// The receipt key of the domain, made for this run; a second key is never registered.
const registered = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const KEY_ID = `kljuc-potvrde-${suffix}`;
const spki = (key: typeof registered) =>
  key.publicKey.export({ type: "spki", format: "der" }).toString("base64url");

function signerOf(key: typeof registered, keyId = KEY_ID) {
  const calls: Uint8Array[] = [];
  const signer: ReceiptSigner = {
    async sign(message) {
      calls.push(message);
      const value: SignatureEnvelope = {
        algorithm: "Ed25519",
        keyId,
        keyVersion: "1",
        signatureEncoding: "raw",
        signatureBase64Url: sign(null, Buffer.from(message), key.privateKey).toString("base64url"),
      };
      return { ok: true, value };
    },
  };
  return { signer, calls };
}

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let withActor: WithActor;

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [id.a, `it-ec-${suffix}`]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Fakultet A (test)', 5, '15 minutes')`,
    [id.a],
  );
  for (const name of ["adminA", "vesna", ...students] as const) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
      [id[name], id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const name of [...students, "vesna"] as const) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id[name], id.a],
    );
  }
  await q(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at, closed_at, close_reason)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour', now(), 'logout')`,
    [token.closed, id.ana, id.a],
  );
  await q("SELECT institution.appoint_institution_admin($1, $2)", [id.adminA, `Zahtjev ${suffix}`]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now())`,
    [id.a, id.vesna, id.adminA],
  );
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'teacher' UNION ALL SELECT $1::uuid, $2::uuid, unnest($4::uuid[]), 'student'`,
    [id.k1, id.a, id.vesna, students.map((name) => id[name])],
  );
  await q(
    `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
     VALUES ($1, $2, $3, 1, $4)`,
    [id.z1, id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
       opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
     VALUES ($1, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
       now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
    [id.z1, id.vesna],
  );
  await q(
    `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
     SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
    [id.z1, students.map((name) => id[name]), id.a],
  );
  await q(
    "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, $2, 'eu-central-1')",
    [id.domainA, id.a],
  );
  await q(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     VALUES ($1, '1', $2, $3, 'receipt', 'Ed25519', $4, date_trunc('minute', now()) - interval '1 day')`,
    [KEY_ID, id.domainA, id.a, spki(registered)],
  );
  await q("COMMIT");
}

beforeAll(async () => {
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  await fixture();
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 6 });
  withActor = createWithActor(app);
});

afterAll(async () => {
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Work = { documentId: string; documentHash: string };
async function openWork(who: Student): Promise<Work> {
  const opened = await createWorkOpener(withActor).openWork(token[who], id.z1, true);
  if (!opened.ok) throw new Error(`open: ${opened.error.code}`);
  return opened.value;
}

async function contextOf(who: Student, work: Work, txid: string): Promise<EvidenceCommitContext> {
  const read = await createEvidenceCommitter(withActor, signerOf(registered).signer).readContext(
    token[who],
    work.documentId,
    txid,
  );
  if (read.status !== "ok") throw new Error(`context: ${read.status}`);
  return read.context;
}

type Step = {
  txid: string;
  base: number;
  from: number;
  to?: number;
  initial: string;
  predecessor: string | null;
  text: string;
  segmentId?: string;
};

/** The input the route builds after it verified the bytes; the segment hash is invented. */
function inputOf(context: EvidenceCommitContext, work: Work, step: Step): EvidenceCommitInput {
  const snapshot = JSON.stringify({ naslov: step.text });
  const to = step.to ?? step.from;
  const segmentHash = sha256(`segment ${step.txid} ${step.segmentId ?? ""}`);
  return {
    context,
    documentId: work.documentId,
    clientTransactionId: step.txid,
    baseRevision: step.base,
    initialDocumentHash: step.initial,
    finalDocumentHash: sha256(snapshot),
    descriptor: {
      evidencePackageId: context.evidencePackageId,
      documentId: work.documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: step.segmentId ?? `segment-${step.txid}`,
      evidenceSchema: "ductus-evidence-segment-v2",
      canonicalization: "RFC8785-JCS",
      hashAlgorithm: "sha256",
      evidenceProfileId: context.evidenceProfileId,
      sequenceFrom: step.from,
      sequenceTo: to,
      eventCount: to - step.from + 1,
      observedStartedAt: "2026-11-16T06:00:00.000Z",
      observedEndedAt: "2026-11-16T06:01:00.000Z",
      segmentHash,
      predecessorSegmentHash: step.predecessor,
      payloadBytes: 321,
    },
    storageRef: `local-test:v2/${context.institutionId}/${context.evidencePackageId}/${segmentHash}.json`,
    snapshot,
  };
}

async function commit(who: Student, work: Work, step: Step, key = signerOf(registered)) {
  const context = await contextOf(who, work, step.txid);
  const input = inputOf(context, work, step);
  const outcome = await createEvidenceCommitter(withActor, key.signer).commit(token[who], input);
  return { outcome, input, context, calls: key.calls };
}

const row = async (text: string, values: unknown[]) => (await admin.query(text, values)).rows[0];
const revisionOf = async (work: Work) =>
  Number(
    (await row("SELECT current_revision FROM evidence.document WHERE id = $1", [work.documentId]))
      ?.current_revision,
  );
const receiptsOf = async (work: Work) =>
  Number(
    (
      await row(
        "SELECT count(*) AS n FROM evidence.receipt r JOIN evidence.package p ON p.id = r.evidence_package_id WHERE p.document_id = $1",
        [work.documentId],
      )
    )?.n,
  );

describe("evidence commit transaction over real PostgreSQL with RLS", () => {
  let ana: Work;
  let first: Awaited<ReturnType<typeof commit>>;
  const firstStep = (initial: string): Step => ({
    txid: `tx-${suffix}-1`,
    base: 0,
    from: 1,
    to: 3,
    initial,
    predecessor: null,
    text: "Prvi izmišljeni odlomak.",
  });

  beforeAll(async () => {
    ana = await openWork("ana");
    first = await commit("ana", ana, firstStep(ana.documentHash));
  });

  it("D1: the first segment commits revision 1 with a receipt that verifies under the registry key", async () => {
    expect(first.outcome).toMatchObject({ status: "committed", revision: 1 });
    if (first.outcome.status !== "committed") throw new Error("not committed");
    expect(first.calls).toHaveLength(1);
    const verified = await verifySignedEvidenceReceiptV2(
      first.outcome.signedReceipt,
      {
        documentId: ana.documentId,
        clientTransactionId: first.input.clientTransactionId,
        revision: 1,
        evidenceDomainId: id.domainA,
      },
      [
        {
          algorithm: "Ed25519",
          keyId: KEY_ID,
          keyVersion: "1",
          encoding: "spki-der",
          keyBase64Url: spki(registered),
          evidenceDomainId: id.domainA,
          purpose: "receipt",
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: null,
          revokedAt: null,
        },
      ],
    );
    expect(verified.ok).toBe(true);
    expect(await revisionOf(ana)).toBe(1);
    const stored = await row("SELECT r.status FROM evidence.receipt r WHERE r.id = $1", [
      first.outcome.signedReceipt.payload.receiptId,
    ]);
    expect(stored?.status).toBe("signed");
    // G3: the next open reports the committed revision and its snapshot.
    const reopened = await openWork("ana");
    expect(reopened.documentHash).toBe(first.input.finalDocumentHash);
  });

  it("D2: the same request again is the stored receipt, byte for byte, and never a new signature", async () => {
    const context = await contextOf("ana", ana, first.input.clientTransactionId);
    expect(context.transactionKnown).toBe(true);
    const key = signerOf(registered);
    const again = await createEvidenceCommitter(withActor, key.signer).commit(token.ana, {
      ...first.input,
      context,
    });
    expect(again.status).toBe("duplicate");
    if (again.status !== "duplicate" || first.outcome.status !== "committed") throw new Error();
    expect(JSON.stringify(again.signedReceipt)).toBe(JSON.stringify(first.outcome.signedReceipt));
    expect(key.calls).toHaveLength(0);
    expect(await revisionOf(ana)).toBe(1);
    expect(await receiptsOf(ana)).toBe(1);
  });

  it("D3: the same transaction id with another segment is txid_reused", async () => {
    const reused = await commit("ana", ana, {
      ...firstStep(ana.documentHash),
      segmentId: `drugi-${suffix}`,
    });
    expect(reused.outcome).toEqual({ status: "txid_reused" });
    expect(reused.calls).toHaveLength(0);
  });

  it("D4, D5, D6: a stale base, a wrong predecessor and a gap answer the chain's state", async () => {
    if (first.outcome.status !== "committed") throw new Error();
    const head = first.input.descriptor.segmentHash;
    const state = {
      currentRevision: 1,
      documentHash: first.input.finalDocumentHash,
      headSegmentHash: head,
      lastSequenceTo: 3,
    };
    const base = { initial: first.input.finalDocumentHash, text: "Drugi odlomak." };
    const stale = await commit("ana", ana, {
      ...base,
      txid: `tx-${suffix}-s`,
      base: 0,
      from: 4,
      predecessor: head,
    });
    expect(stale.outcome).toEqual({ status: "stale_base", state });
    const chain = await commit("ana", ana, {
      ...base,
      txid: `tx-${suffix}-c`,
      base: 1,
      from: 4,
      predecessor: null,
    });
    expect(chain.outcome).toEqual({ status: "chain_conflict", state });
    const gap = await commit("ana", ana, {
      ...base,
      txid: `tx-${suffix}-g`,
      base: 1,
      from: 6,
      predecessor: head,
    });
    expect(gap.outcome).toEqual({ status: "not_continuous", state });
    const back = await commit("ana", ana, {
      ...base,
      txid: `tx-${suffix}-b`,
      base: 1,
      from: 2,
      predecessor: head,
    });
    expect(back.outcome).toEqual({ status: "invalid" });
    for (const attempt of [stale, chain, gap, back]) expect(attempt.calls).toHaveLength(0);
    expect(await revisionOf(ana)).toBe(1);
  });

  it("D7: two parallel commits on the same base make one revision and one stale_base", async () => {
    const eva = await openWork("eva");
    const step = (n: number): Step => ({
      txid: `tx-${suffix}-eva-${n}`,
      base: 0,
      from: 1,
      initial: eva.documentHash,
      predecessor: null,
      text: `Usporedni odlomak ${n}.`,
    });
    const [one, two] = await Promise.all([
      commit("eva", eva, step(1)),
      commit("eva", eva, step(2)),
    ]);
    expect([one.outcome.status, two.outcome.status].sort()).toEqual(["committed", "stale_base"]);
    expect(await revisionOf(eva)).toBe(1);
    expect(await receiptsOf(eva)).toBe(1);
  });

  it("D8: two parallel commits with the same key make one receipt", async () => {
    const iva = await openWork("iva");
    const step: Step = {
      txid: `tx-${suffix}-iva`,
      base: 0,
      from: 1,
      initial: iva.documentHash,
      predecessor: null,
      text: "Isti ključ dvaput.",
    };
    const answers = await Promise.all([commit("iva", iva, step), commit("iva", iva, step)]);
    const statuses = answers.map((a) => a.outcome.status).sort();
    expect(statuses).toEqual(["committed", "duplicate"]);
    expect(await revisionOf(iva)).toBe(1);
    expect(await receiptsOf(iva)).toBe(1);
  });

  it("E1, E2, E4: a failed or unverified signature rolls everything back, and a retry signs anew", async () => {
    const dora = await openWork("dora");
    const step: Step = {
      txid: `tx-${suffix}-dora`,
      base: 0,
      from: 1,
      initial: dora.documentHash,
      predecessor: null,
      text: "Odlomak bez potpisa.",
    };
    const failing: ReceiptSigner = {
      sign: async () => ({ ok: false, error: { code: "KMS_DOWN", messageKey: "x" } }),
    };
    const context = await contextOf("dora", dora, step.txid);
    const input = inputOf(context, dora, step);
    expect(await createEvidenceCommitter(withActor, failing).commit(token.dora, input)).toEqual({
      status: "unavailable",
      stage: "signing",
      code: "signing_failed",
    });
    const unknownKey = await commit("dora", dora, step, signerOf(stranger, `drugi-${suffix}`));
    expect(unknownKey.outcome).toEqual({
      status: "unavailable",
      stage: "signing",
      code: "signature_unverified",
    });
    // A known key id over another private key does not verify either.
    const forged = await commit("dora", dora, step, signerOf(stranger));
    expect(forged.outcome).toMatchObject({ stage: "signing", code: "signature_unverified" });
    expect(await revisionOf(dora)).toBe(0);
    expect(await receiptsOf(dora)).toBe(0);
    const segments = await row(
      "SELECT count(*) AS n FROM evidence.segment WHERE document_id = $1",
      [dora.documentId],
    );
    expect(Number(segments?.n)).toBe(0);
    const retried = await commit("dora", dora, step);
    expect(retried.outcome).toMatchObject({ status: "committed", revision: 1 });
  });

  it("D9: another student's, an unknown and the teacher's document are the same not_found", async () => {
    const committer = createEvidenceCommitter(withActor, signerOf(registered).signer);
    for (const [who, documentId] of [
      [token.eva, ana.documentId],
      [token.ana, `nepostojeci-${suffix}`],
      [token.vesna, ana.documentId],
    ] as const) {
      expect(await committer.readContext(who, documentId, `tx-${suffix}-x`)).toEqual({
        status: "not_found",
      });
    }
    // With ana's own package, eva's transaction is refused by the RPC itself.
    const context = await contextOf("ana", ana, `tx-${suffix}-eva-x`);
    const input = inputOf(context, ana, {
      txid: `tx-${suffix}-eva-x`,
      base: 1,
      from: 4,
      initial: ana.documentHash,
      predecessor: null,
      text: "Tuđi rad.",
    });
    expect(await committer.commit(token.eva, input)).toEqual({ status: "not_found" });
    expect(await revisionOf(ana)).toBe(1);
  });

  it("D10, D11: a package that stopped accepting and a closed session commit nothing", async () => {
    const committer = createEvidenceCommitter(withActor, signerOf(registered).signer);
    expect(await committer.readContext(token.closed, ana.documentId, `tx-${suffix}-z`)).toEqual({
      status: "unauthenticated",
    });
    const context = await contextOf("ana", ana, `tx-${suffix}-n`);
    if (first.outcome.status !== "committed") throw new Error();
    const input = inputOf(context, ana, {
      txid: `tx-${suffix}-n`,
      base: 1,
      from: 4,
      initial: first.input.finalDocumentHash,
      predecessor: first.input.descriptor.segmentHash,
      text: "Zakašnjeli odlomak.",
    });
    expect(await committer.commit(token.closed, input)).toEqual({ status: "not_found" });
    await admin.query(
      "UPDATE evidence.package SET accepts_evidence = false WHERE document_id = $1",
      [ana.documentId],
    );
    expect(await committer.commit(token.ana, input)).toEqual({ status: "not_accepting" });
    expect(await revisionOf(ana)).toBe(1);
  });
});

const readContext = (who: string, documentId: string, txid: string) =>
  createCommitContextReader(withActor).readContext(who, documentId, txid);

describe("evidence commit context over real PostgreSQL with RLS", () => {
  let mia: Work;
  beforeAll(async () => {
    mia = await openWork("mia");
  });

  it("names the package, domain, profile and chain of the caller's own work", async () => {
    const read = await readContext(token.mia, mia.documentId, `tx-${suffix}-1`);
    expect(read).toEqual({
      status: "ok",
      context: {
        evidencePackageId: expect.any(String),
        institutionId: id.a,
        evidenceDomainId: id.domainA,
        evidenceProfileId: "standard-v1",
        maxPayloadBytes: expect.any(Number),
        transactionKnown: false,
        // SRV-V14-SHEET-COMMIT: the kind of the work, read from evidence.document.
        documentKind: "text",
        // SRV-7F: a work opened today is v1, read from its revision 0.
        documentSchemaVersion: 1,
        state: {
          currentRevision: 0,
          documentHash: mia.documentHash,
          headSegmentHash: null,
          lastSequenceTo: 0,
        },
      },
    });
    const pkg = await admin.query<{ id: string; limit: number }>(
      "SELECT id, max_payload_bytes AS limit FROM evidence.package WHERE document_id = $1",
      [mia.documentId],
    );
    expect(read.status === "ok" && read.context.evidencePackageId).toBe(pkg.rows[0]?.id);
    expect(read.status === "ok" && read.context.maxPayloadBytes).toBe(pkg.rows[0]?.limit);
  });

  it("SRV-V14-SHEET-COMMIT: a spreadsheet kind on a text revision 0 is malformed, never a guess", async () => {
    // Nothing makes a spreadsheet work yet (app.open_student_work), so the
    // owner sets the kind of a text work for this read and puts it back.
    await admin.query("UPDATE evidence.document SET document_kind = 'spreadsheet' WHERE id = $1", [
      mia.documentId,
    ]);
    try {
      expect(await readContext(token.mia, mia.documentId, `tx-${suffix}-k`)).toEqual({
        status: "unavailable",
        stage: "context",
        code: "context_malformed",
      });
    } finally {
      await admin.query("UPDATE evidence.document SET document_kind = 'text' WHERE id = $1", [
        mia.documentId,
      ]);
    }
  });

  it("D9: another student's, an unknown and the teacher's document are the same not_found", async () => {
    for (const [who, documentId] of [
      [token.eva, mia.documentId],
      [token.mia, `nepostojeci-${suffix}`],
      [token.vesna, mia.documentId],
    ] as const) {
      expect(await readContext(who, documentId, `tx-${suffix}-x`)).toEqual({ status: "not_found" });
    }
  });

  it("D11: a closed or unknown session is unauthenticated", async () => {
    for (const who of [token.closed, randomBytes(32).toString("base64url")]) {
      expect(await readContext(who, mia.documentId, `tx-${suffix}-z`)).toEqual({
        status: "unauthenticated",
      });
    }
  });

  it("C5: an empty or control-character transaction id is invalid before any lookup", async () => {
    for (const txid of ["", "tx\n1", "tx\u00071"]) {
      expect(await readContext(token.mia, mia.documentId, txid)).toEqual({ status: "invalid" });
    }
    // PostgreSQL text holds no NUL: the driver fails, and the answer is a closed code.
    expect(await readContext(token.mia, mia.documentId, "tx\u0000")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_failed",
    });
  });
});
