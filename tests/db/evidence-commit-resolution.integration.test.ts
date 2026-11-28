import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createEvidenceCommitter,
  createWithActor,
  createWorkOpener,
  type EvidenceCommitContext,
  type EvidenceCommitInput,
  type EvidenceCommitOutcome,
  type ReceiptSigner,
  type WithActor,
} from "../../server/database/index.ts";
import type { SignatureEnvelope } from "../../server/domain/index.ts";

// F4-EDI-R05-SRV (variant A): "keep the text from this device" over the
// existing commit, with no change to the server. Device B moves the work to
// revision N; device A's commit is refused with stale_base or chain_conflict
// and the head state. Device A resolves it with a new segment on that head
// (predecessor = headSegmentHash, sequenceFrom = lastSequenceTo + 1,
// initialDocumentHash = documentHash, base = currentRevision), which is an
// ordinary revision N + 1 that leaves revision N and device B's work in the
// chain. Over real PostgreSQL with RLS, through a ductus_app login as in
// production, at the committer as tests/db/evidence-commit.integration.test.ts
// does. Every institution, person, course, token, key and text is random and
// synthetic; the login exists only while this file runs. The service's
// checks of the same segment before storage are server/evidence/resolution.test.ts.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_commit_resolution_app";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");

const students = ["ana", "eva", "iva", "lea", "mia", "nina", "tea", "dora"] as const;
type Student = (typeof students)[number] | "strana";
const id = {
  a: randomUUID(),
  b: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  strana: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  // An assignment whose deadline has passed, still open for work.
  z2: randomUUID(),
  domainA: randomUUID(),
  ...(Object.fromEntries(students.map((name) => [name, randomUUID()])) as Record<
    (typeof students)[number],
    string
  >),
};
const token: Record<Student, string> = Object.fromEntries(
  [...students, "strana"].map((name) => [name, randomBytes(32).toString("base64url")]),
) as never;

const registered = generateKeyPairSync("ed25519");
const KEY_ID = `kljuc-razrjesenja-${suffix}`;
const spki = (key: typeof registered) =>
  key.publicKey.export({ type: "spki", format: "der" }).toString("base64url");

function signerOf(key: typeof registered) {
  const calls: Uint8Array[] = [];
  const signer: ReceiptSigner = {
    async sign(message) {
      calls.push(message);
      const value: SignatureEnvelope = {
        algorithm: "Ed25519",
        keyId: KEY_ID,
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
  for (const [institution, slug, name] of [
    [id.a, `it-er-a-${suffix}`, "Fakultet A (test)"],
    [id.b, `it-er-b-${suffix}`, "Fakultet B (test)"],
  ] as const) {
    await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [institution, slug]);
    await q(
      `INSERT INTO institution.institution_settings
         (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
       VALUES ($1, $2, 5, '15 minutes')`,
      [institution, name],
    );
  }
  const accounts = [
    ...(["adminA", "vesna", ...students] as const).map((name) => [name, id.a] as const),
    ["strana", id.b] as const,
  ];
  for (const [name, institution] of accounts) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
      [id[name], institution, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
    if (name === "adminA" || name === "vesna") continue;
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id[name], institution],
    );
  }
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
  for (const [assignment, opensAt, dueAt] of [
    [id.z1, "now()", "now() + interval '30 days'"],
    [id.z2, "now() - interval '2 days'", "now() - interval '1 day'"],
  ] as const) {
    await q(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
       VALUES ($1, $2, $3, 1, $4)`,
      [assignment, id.k1, id.a, id.vesna],
    );
    await q(
      `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
         opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
       VALUES ($1, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', ${opensAt},
         ${dueAt}, 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
      [assignment, id.vesna],
    );
    await q(
      `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
       SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
      [assignment, students.map((name) => id[name]), id.a],
    );
  }
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
async function openWork(who: Student, assignment = id.z1): Promise<Work> {
  const opened = await createWorkOpener(withActor).openWork(token[who], assignment, true);
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
  to: number;
  initial: string;
  predecessor: string | null;
  text: string;
  segmentId?: string;
  /** Another snapshot than the one the final hash names. */
  snapshot?: string;
};

/** The input the route builds after it verified the bytes; the segment hash is invented. */
function inputOf(context: EvidenceCommitContext, work: Work, step: Step): EvidenceCommitInput {
  const snapshot = JSON.stringify({ naslov: step.text });
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
      sequenceTo: step.to,
      eventCount: step.to - step.from + 1,
      observedStartedAt: "2026-11-16T06:00:00.000Z",
      observedEndedAt: "2026-11-16T06:01:00.000Z",
      segmentHash,
      predecessorSegmentHash: step.predecessor,
      payloadBytes: 321,
    },
    storageRef: `local-test:v2/${context.institutionId}/${context.evidencePackageId}/${segmentHash}.json`,
    snapshot: step.snapshot ?? snapshot,
    aiTransferLinks: null,
  };
}

async function commit(who: Student, work: Work, step: Step) {
  const key = signerOf(registered);
  const context = await contextOf(who, work, step.txid);
  const input = inputOf(context, work, step);
  const outcome = await createEvidenceCommitter(withActor, key.signer).commit(token[who], input);
  return { outcome, input, calls: key.calls };
}

type State = {
  currentRevision: number;
  documentHash: string;
  headSegmentHash: string | null;
  lastSequenceTo: number;
};
const start = (work: Work): State => ({
  currentRevision: 0,
  documentHash: work.documentHash,
  headSegmentHash: null,
  lastSequenceTo: 0,
});

/** A segment of two events on a head: an ordinary commit, or device A's resolution of a 409. */
const onHead = (state: State, txid: string, text: string, change: Partial<Step> = {}): Step => ({
  txid,
  base: state.currentRevision,
  from: state.lastSequenceTo + 1,
  to: state.lastSequenceTo + 2,
  initial: state.documentHash,
  predecessor: state.headSegmentHash,
  text,
  ...change,
});

// The member's status is "committed" | "duplicate", so it is picked by its receipt.
type Committed = Extract<EvidenceCommitOutcome, { signedReceipt: unknown }>;
function committed(outcome: EvidenceCommitOutcome): Committed {
  if (outcome.status !== "committed") throw new Error(`not committed: ${outcome.status}`);
  return outcome;
}
function refusedState(outcome: EvidenceCommitOutcome): State {
  if (!("state" in outcome)) throw new Error(`no state: ${outcome.status}`);
  return outcome.state;
}
const headAfter = (done: Awaited<ReturnType<typeof commit>>): State => ({
  currentRevision: committed(done.outcome).revision,
  documentHash: done.input.finalDocumentHash,
  headSegmentHash: done.input.descriptor.segmentHash,
  lastSequenceTo: done.input.descriptor.sequenceTo,
});

/** Device B moves a fresh work to revision `n`, one segment per revision. */
async function deviceB(who: Student, work: Work, n: number, tag: string): Promise<State> {
  let state = start(work);
  for (let r = 1; r <= n; r++) {
    state = headAfter(
      await commit(who, work, onHead(state, `tx-${suffix}-${tag}-b${r}`, `B ${r}`)),
    );
  }
  return state;
}

const rows = async <T extends pg.QueryResultRow>(text: string, values: unknown[]) =>
  (await admin.query<T>(text, values)).rows;
/** The whole chain of a work as the database holds it, in order. */
async function chainOf(work: Work) {
  const [document] = await rows<{ revision: number; hash: string }>(
    `SELECT current_revision::int AS "revision", current_content_hash AS "hash"
       FROM evidence.document WHERE id = $1`,
    [work.documentId],
  );
  const [pkg] = await rows<{ head: string | null; headReceipt: string | null; last: number }>(
    `SELECT head_segment_hash AS "head", head_receipt_id::text AS "headReceipt",
            last_sequence_to::int AS "last"
       FROM evidence.package WHERE document_id = $1`,
    [work.documentId],
  );
  const revisions = await rows<{ revision: number; base: number | null; hash: string }>(
    `SELECT revision::int AS "revision", base_revision::int AS "base", content_hash AS "hash"
       FROM evidence.document_revision WHERE document_id = $1 ORDER BY revision`,
    [work.documentId],
  );
  const checkpoints = await rows<{ revision: number; body: string; hash: string }>(
    `SELECT revision::int AS "revision", body AS "body", content_hash AS "hash"
       FROM evidence.document_checkpoint WHERE document_id = $1 ORDER BY revision`,
    [work.documentId],
  );
  const segments = await rows<{
    segmentId: string;
    from: number;
    to: number;
    hash: string;
    predecessor: string | null;
  }>(
    `SELECT id AS "segmentId", sequence_from::int AS "from", sequence_to::int AS "to",
            segment_hash AS "hash", descriptor->>'predecessorSegmentHash' AS "predecessor"
       FROM evidence.segment WHERE document_id = $1 ORDER BY sequence_from`,
    [work.documentId],
  );
  const receipts = await rows<{
    receiptId: string;
    previous: string | null;
    segmentId: string;
    payload: string;
    signature: string | null;
    revision: number;
  }>(
    `SELECT r.id::text AS "receiptId", r.previous_receipt_id::text AS "previous",
            r.segment_id AS "segmentId", r.receipt_payload AS "payload",
            r.signature::text AS "signature", (r.receipt_payload::jsonb->>'revision')::int AS "revision"
       FROM evidence.receipt r JOIN evidence.package p ON p.id = r.evidence_package_id
      WHERE p.document_id = $1 ORDER BY 6`,
    [work.documentId],
  );
  return { document: document!, pkg: pkg!, revisions, checkpoints, segments, receipts };
}

/** From revision 0, every revision, segment and receipt continues the one before it. */
function expectUnbrokenFromZero(chain: Awaited<ReturnType<typeof chainOf>>, head: number) {
  expect(chain.revisions.map((r) => r.revision)).toEqual([...Array(head + 1).keys()]);
  for (const r of chain.revisions) expect(r.base).toBe(r.revision === 0 ? null : r.revision - 1);
  expect(chain.segments).toHaveLength(head);
  expect(chain.receipts.map((r) => r.revision)).toEqual([...Array(head).keys()].map((r) => r + 1));
  let last = 0;
  let predecessor: string | null = null;
  let previousReceipt: string | null = null;
  chain.segments.forEach((segment, index) => {
    expect(segment.from).toBe(last + 1);
    expect(segment.predecessor).toBe(predecessor);
    const receipt = chain.receipts[index]!;
    expect(receipt.segmentId).toBe(segment.segmentId);
    expect(receipt.previous).toBe(previousReceipt);
    last = segment.to;
    predecessor = segment.hash;
    previousReceipt = receipt.receiptId;
  });
  expect(chain.pkg).toEqual({ head: predecessor, headReceipt: previousReceipt, last });
  expect(chain.document).toEqual({ revision: head, hash: chain.revisions[head]!.hash });
}

describe("keeping the text from this device: a resolving segment on the head", () => {
  const N = 3;
  let ana: Work;
  let headN: State;
  let refused: State;
  let before: Awaited<ReturnType<typeof chainOf>>;

  beforeAll(async () => {
    ana = await openWork("ana");
    headN = await deviceB("ana", ana, N, "ana");
  });

  it("R1: device A's commit on the base it knew is refused with the head state", async () => {
    const first = (await chainOf(ana)).revisions[1]!;
    const segment1 = (await chainOf(ana)).segments[0]!;
    const stale = await commit("ana", ana, {
      txid: `tx-${suffix}-ana-a1`,
      base: 1,
      from: segment1.to + 1,
      to: segment1.to + 2,
      initial: first.hash,
      predecessor: segment1.hash,
      text: "Tekst s uređaja A.",
    });
    expect(stale.outcome).toEqual({ status: "stale_base", state: headN });
    // On base N but after the segment it knew: chain_conflict, with the same state.
    const chain = await commit("ana", ana, {
      txid: `tx-${suffix}-ana-a2`,
      base: N,
      from: segment1.to + 1,
      to: segment1.to + 2,
      initial: first.hash,
      predecessor: segment1.hash,
      text: "Tekst s uređaja A.",
    });
    expect(chain.outcome).toEqual({ status: "chain_conflict", state: headN });
    refused = refusedState(stale.outcome);
    for (const attempt of [stale, chain]) expect(attempt.calls).toHaveLength(0);
    expect((await chainOf(ana)).document.revision).toBe(N);
  });

  it("R2: a resolution that does not start at the head is refused, and nothing is written", async () => {
    before = await chainOf(ana);
    const text = "Tekst s uređaja A.";
    const cases: [Step, EvidenceCommitOutcome][] = [
      [
        onHead(refused, `tx-${suffix}-ana-r1`, text, { base: N - 1 }),
        { status: "stale_base", state: headN },
      ],
      [
        onHead(refused, `tx-${suffix}-ana-r2`, text, { base: N + 1 }),
        { status: "stale_base", state: headN },
      ],
      [
        onHead(refused, `tx-${suffix}-ana-r3`, text, { predecessor: before.segments[N - 2]!.hash }),
        { status: "chain_conflict", state: headN },
      ],
      [
        onHead(refused, `tx-${suffix}-ana-r4`, text, { initial: before.revisions[N - 1]!.hash }),
        { status: "not_continuous", state: headN },
      ],
      [
        onHead(refused, `tx-${suffix}-ana-r5`, text, {
          from: refused.lastSequenceTo,
          to: refused.lastSequenceTo + 1,
        }),
        { status: "invalid" },
      ],
    ];
    for (const [step, expected] of cases) {
      const attempt = await commit("ana", ana, step);
      expect(attempt.outcome).toEqual(expected);
      expect(attempt.calls).toHaveLength(0);
    }
    expect(await chainOf(ana)).toEqual(before);
  });

  it("R3: the resolution from the refusal's state is revision N + 1, and revision N stays as it was", async () => {
    const resolution = onHead(refused, `tx-${suffix}-ana-k`, "Tekst s uređaja A, zadržan.");
    const done = await commit("ana", ana, resolution);
    const receipt = committed(done.outcome);
    expect(receipt.revision).toBe(N + 1);
    expect(receipt.signedReceipt.payload).toMatchObject({
      revision: N + 1,
      predecessorSegmentHash: headN.headSegmentHash,
      sequenceFrom: headN.lastSequenceTo + 1,
    });

    const after = await chainOf(ana);
    expectUnbrokenFromZero(after, N + 1);
    // Revision N, its checkpoint and its receipt are unchanged, byte for byte.
    expect(after.revisions[N]).toEqual(before.revisions[N]);
    expect(after.checkpoints.find((c) => c.revision === N)).toEqual(
      before.checkpoints.find((c) => c.revision === N),
    );
    expect(after.receipts[N - 1]).toEqual(before.receipts[N - 1]);
    expect(after.revisions.slice(0, N + 1)).toEqual(before.revisions);
    expect(after.segments.slice(0, N)).toEqual(before.segments);
    expect(after.receipts.slice(0, N)).toEqual(before.receipts);
    // N + 1 continues N: its receipt names N's, its document starts at N's.
    expect(after.receipts[N]!.previous).toBe(before.receipts[N - 1]!.receiptId);
    expect(receipt.signedReceipt.payload.previousReceiptId).toBe(before.receipts[N - 1]!.receiptId);
    expect(resolution.initial).toBe(before.revisions[N]!.hash);
    expect(after.revisions[N + 1]!.hash).toBe(done.input.finalDocumentHash);
    expect(after.checkpoints.find((c) => c.revision === N + 1)?.body).toBe(done.input.snapshot);
  });

  it("R4: another student's work, another student's package and another institution's student are the same not_found as no work", async () => {
    const at = await chainOf(ana);
    const committer = createEvidenceCommitter(withActor, signerOf(registered).signer);
    const missing = await committer.readContext(
      token.ana,
      `nepostojeci-${suffix}`,
      `tx-${suffix}-x`,
    );
    expect(missing).toEqual({ status: "not_found" });
    for (const who of [token.eva, token.strana]) {
      expect(await committer.readContext(who, ana.documentId, `tx-${suffix}-x`)).toEqual(missing);
    }
    // With ana's own package and a resolution on her head, the RPC itself refuses.
    const head: State = {
      currentRevision: at.document.revision,
      documentHash: at.document.hash,
      headSegmentHash: at.pkg.head,
      lastSequenceTo: at.pkg.last,
    };
    const step = onHead(head, `tx-${suffix}-tudi`, "Tuđi tekst.");
    const input = inputOf(await contextOf("ana", ana, step.txid), ana, step);
    for (const who of [token.eva, token.strana]) {
      expect(await committer.commit(who, input)).toEqual(missing);
    }
    expect(await chainOf(ana)).toEqual(at);
  });
});

describe("repeats of a resolution", () => {
  it("R5: a transaction id refused with stale_base commits the resolution; the same request again is duplicate; another segment is txid_reused", async () => {
    const iva = await openWork("iva");
    const head = await deviceB("iva", iva, 2, "iva");
    const txid = `tx-${suffix}-iva-a`;
    const stale = await commit("iva", iva, onHead(start(iva), txid, "Tekst s uređaja A."));
    expect(stale.outcome).toEqual({ status: "stale_base", state: head });

    // The same transaction id, now with the resolving segment: it was never stored, so it passes.
    const step = onHead(refusedState(stale.outcome), txid, "Tekst s uređaja A, zadržan.");
    const done = await commit("iva", iva, step);
    const first = committed(done.outcome);
    expect(first.revision).toBe(3);

    const again = await commit("iva", iva, step);
    expect(again.outcome.status).toBe("duplicate");
    if (again.outcome.status !== "duplicate") throw new Error();
    expect(again.outcome.revision).toBe(3);
    expect(JSON.stringify(again.outcome.signedReceipt)).toBe(JSON.stringify(first.signedReceipt));
    expect(again.calls).toHaveLength(0);

    const reused = await commit("iva", iva, { ...step, segmentId: `drugi-${suffix}` });
    expect(reused.outcome).toEqual({ status: "txid_reused" });
    expect(reused.calls).toHaveLength(0);

    expectUnbrokenFromZero(await chainOf(iva), 3);
  });
});

describe("a resolution against a normal commit", () => {
  it("R6: a resolution and device B's commit on the same base N, in parallel, make one N + 1 and one stale_base", async () => {
    const lea = await openWork("lea");
    const head = await deviceB("lea", lea, 1, "lea");
    const stale = await commit("lea", lea, onHead(start(lea), `tx-${suffix}-lea-a`, "A."));
    const state = refusedState(stale.outcome);
    expect(state).toEqual(head);
    const [resolution, normal] = await Promise.all([
      commit("lea", lea, onHead(state, `tx-${suffix}-lea-k`, "Tekst s uređaja A, zadržan.")),
      commit("lea", lea, onHead(head, `tx-${suffix}-lea-b2`, "B 2")),
    ]);
    const statuses = [resolution.outcome.status, normal.outcome.status].sort();
    expect(statuses).toEqual(["committed", "stale_base"]);
    const winner = resolution.outcome.status === "committed" ? resolution : normal;
    const loser = winner === resolution ? normal : resolution;
    expect(committed(winner.outcome).revision).toBe(2);
    expect(loser.outcome).toEqual({ status: "stale_base", state: headAfter(winner) });
    expectUnbrokenFromZero(await chainOf(lea), 2);
  });
});

describe("a resolving segment the acceptance refuses", () => {
  it("R7: a segment id already in the package is invalid, and a snapshot that is not the final document is refused", async () => {
    const tea = await openWork("tea");
    const head = await deviceB("tea", tea, 1, "tea");
    const at = await chainOf(tea);
    const sameId = await commit(
      "tea",
      tea,
      onHead(head, `tx-${suffix}-tea-k1`, "A.", { segmentId: at.segments[0]!.segmentId }),
    );
    expect(sameId.outcome).toEqual({ status: "invalid" });
    // The service answers document_mismatch before storage (resolution.test.ts);
    // the acceptance refuses the same snapshot as invalid if it ever got there.
    const mismatch = await commit(
      "tea",
      tea,
      onHead(head, `tx-${suffix}-tea-k2`, "A.", { snapshot: JSON.stringify({ naslov: "B." }) }),
    );
    expect(mismatch.outcome).toEqual({ status: "invalid" });
    for (const attempt of [sameId, mismatch]) expect(attempt.calls).toHaveLength(0);
    expect(await chainOf(tea)).toEqual(at);
  });

  it("R8: a resolving segment over the package's payload limit is too_large, never unavailable", async () => {
    const dora = await openWork("dora");
    const head = await deviceB("dora", dora, 1, "dora");
    // The segment's 321 bytes over this package's limit.
    await admin.query(
      "UPDATE evidence.package SET max_payload_bytes = 300 WHERE document_id = $1",
      [dora.documentId],
    );
    const at = await chainOf(dora);
    const big = await commit("dora", dora, onHead(head, `tx-${suffix}-dora-k`, "A."));
    expect(big.outcome).toEqual({ status: "too_large" });
    expect(big.calls).toHaveLength(0);
    expect(await chainOf(dora)).toEqual(at);
  });
});

describe("a resolution and submission", () => {
  it("R9: after submission a resolution is refused, and one accepted before it repeats as duplicate", async () => {
    const mia = await openWork("mia");
    const head = await deviceB("mia", mia, 1, "mia");
    const stale = await commit("mia", mia, onHead(start(mia), `tx-${suffix}-mia-a`, "A."));
    const step = onHead(refusedState(stale.outcome), `tx-${suffix}-mia-k`, "A, zadržan.");
    const done = await commit("mia", mia, step);
    const first = committed(done.outcome);
    expect(first.revision).toBe(2);
    // Submission closes the package (evidence.close_submitted_packages), as D10 holds.
    await admin.query(
      "UPDATE evidence.package SET accepts_evidence = false WHERE document_id = $1",
      [mia.documentId],
    );
    const again = await commit("mia", mia, step);
    expect(again.outcome).toMatchObject({ status: "duplicate", revision: 2 });
    if (again.outcome.status !== "duplicate") throw new Error();
    expect(JSON.stringify(again.outcome.signedReceipt)).toBe(JSON.stringify(first.signedReceipt));
    // A new commit and a new resolution on the closed package are both refused.
    const late = onHead(head, `tx-${suffix}-mia-b2`, "B 2");
    expect((await commit("mia", mia, late)).outcome).toEqual({ status: "not_accepting" });
    const resolved = onHead(headAfter(done), `tx-${suffix}-mia-k2`, "A, opet.");
    const refusedAfter = await commit("mia", mia, resolved);
    expect(refusedAfter.outcome).toEqual({ status: "not_accepting" });
    expect(refusedAfter.calls).toHaveLength(0);
    expectUnbrokenFromZero(await chainOf(mia), 2);
  });

  it("R10: after the deadline but before submission a resolution is committed", async () => {
    const nina = await openWork("nina", id.z2);
    const head = await deviceB("nina", nina, 1, "nina");
    const stale = await commit("nina", nina, onHead(start(nina), `tx-${suffix}-nina-a`, "A."));
    expect(stale.outcome).toEqual({ status: "stale_base", state: head });
    const done = await commit(
      "nina",
      nina,
      onHead(refusedState(stale.outcome), `tx-${suffix}-nina-k`, "A, zadržan nakon roka."),
    );
    expect(committed(done.outcome).revision).toBe(2);
    expectUnbrokenFromZero(await chainOf(nina), 2);
  });
});
