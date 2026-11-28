import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createEvidenceCommitter,
  createPendingReceiptQueue,
  createPendingReceiptStore,
  createWithActor,
  createWorkOpener,
  type EvidenceCommitInput,
  readReceiptKeys,
  type ReceiptSigner,
  type WithActor,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  isEvidenceReceiptPayloadV2,
  type EvidenceReceiptPayloadV2,
  type SignatureEnvelope,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// DAN-820 820b-2c-1, plan of attack ductura/server#146 S-1: the worker's
// reads of pending receipts (820b-1, 820b-2a) over real PostgreSQL, against
// two real pending receipts that a deferred commit made through a ductus_app
// login. A login that is only ductus_worker reads them; ductus_app is refused
// with 42501. Every institution, person, token, key and text is random and
// synthetic; the logins and the pending receipts are gone after the run.
const ADMIN_URL = requireLoopbackDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
  "DATABASE_URL must point at this machine",
);
const suffix = randomBytes(4).toString("hex");
const password = randomBytes(24).toString("hex");
const LOGIN = { app: `it_prw_app_${suffix}`, worker: `it_prw_worker_${suffix}` };
const students = ["ana", "iva"] as const;
const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  ana: randomUUID(),
  iva: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  domain: randomUUID(),
};
const token = {
  ana: randomBytes(32).toString("base64url"),
  iva: randomBytes(32).toString("base64url"),
};
const KEY_ID = `kljuc-potvrde-${suffix}`;
// Two receipt keys of the domain, so the two racing attaches send different signatures.
const KEYS = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
const KEY_IDS = [KEY_ID, `${KEY_ID}-2`];
const spki = (k: number) =>
  KEYS[k]!.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const SPKI = spki(0);

// The commit is deferred, so the signer must never be asked.
let signerCalls = 0;
const signer: ReceiptSigner = {
  sign() {
    signerCalls += 1;
    throw new Error("a deferred commit never signs");
  },
};

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
const pools: pg.Pool[] = [];
let withActor: WithActor;
let worker: pg.Pool;
let app: pg.Pool;
const txid = (who: string) => `tx-${suffix}-${who}`;

function urlOf(user: string): string {
  const target = new URL(ADMIN_URL);
  target.username = user;
  target.password = password;
  return target.href;
}

function pool(user: string): pg.Pool {
  const made = new pg.Pool({ connectionString: urlOf(user), max: 2 });
  pools.push(made);
  return made;
}

async function login(user: string, group: string): Promise<void> {
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE %I', $1::text, $2::text, $3::text) AS ddl",
    [user, password, group],
  );
  await admin.query(ddl.rows[0]!.ddl);
}

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    id.a,
    `it-prw-${suffix}`,
  ]);
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
  for (const name of students) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id[name], id.a],
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
    [id.domain, id.a],
  );
  await q(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     SELECT k, '1', $2, $3, 'receipt', 'Ed25519', b, date_trunc('minute', now()) - interval '1 day'
       FROM unnest($1::text[], $4::text[]) AS t(k, b)`,
    [KEY_IDS, id.domain, id.a, [spki(0), spki(1)]],
  );
  await q("COMMIT");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** One deferred commit of a first segment, as the route builds it after checking the bytes. */
async function commitDeferred(who: (typeof students)[number]) {
  const opened = await createWorkOpener(withActor).openWork(token[who], id.z1, true);
  if (!opened.ok) throw new Error(`open: ${opened.error.code}`);
  const { documentId, documentHash } = opened.value;
  const committer = createEvidenceCommitter(withActor, signer);
  const read = await committer.readContext(token[who], documentId, txid(who));
  if (read.status !== "ok") throw new Error(`context: ${read.status}`);
  const { context } = read;
  const snapshot = JSON.stringify({ naslov: `Izmišljeni odlomak ${who}.` });
  const segmentHash = sha256(`segment ${txid(who)}`);
  const input: EvidenceCommitInput = {
    context,
    documentId,
    clientTransactionId: txid(who),
    baseRevision: 0,
    initialDocumentHash: documentHash,
    finalDocumentHash: sha256(snapshot),
    descriptor: {
      evidencePackageId: context.evidencePackageId,
      documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: `segment-${who}`,
      evidenceSchema: "ductus-evidence-segment-v2",
      canonicalization: "RFC8785-JCS",
      hashAlgorithm: "sha256",
      evidenceProfileId: context.evidenceProfileId,
      sequenceFrom: 1,
      sequenceTo: 1,
      eventCount: 1,
      observedStartedAt: "2026-11-16T06:00:00.000Z",
      observedEndedAt: "2026-11-16T06:01:00.000Z",
      segmentHash,
      predecessorSegmentHash: null,
      payloadBytes: 321,
    },
    storageRef: `local-test:v2/${context.institutionId}/${context.evidencePackageId}/${segmentHash}.json`,
    snapshot,
    aiTransferLinks: null,
    resolution: null,
  };
  const outcome = await committer.commit(token[who], input, "deferred");
  expect(outcome).toEqual({ status: "committed_pending", revision: 1 });
  firstInputs[who] = input;
  return documentId;
}

/** Each first commit's input, for the retries of DAN-821. */
const firstInputs: Partial<Record<(typeof students)[number], EvidenceCommitInput>> = {};
let documents: Record<(typeof students)[number], string>;
/** The pending receipts of the fixture's domain as the administrator reads them, in queue order. */
let stored: { receiptId: string; receiptPayloadText: string }[];

beforeAll(async () => {
  await login(LOGIN.app, "ductus_app");
  await login(LOGIN.worker, "ductus_worker");
  await fixture();
  app = pool(LOGIN.app);
  worker = pool(LOGIN.worker);
  withActor = createWithActor(app);
  documents = { ana: await commitDeferred("ana"), iva: await commitDeferred("iva") };
  const rows = await admin.query<{ id: string; receipt_payload: string }>(
    `SELECT r.id::text AS id, r.receipt_payload FROM evidence.receipt r
      WHERE r.evidence_domain_id = $1 AND r.status = 'pending_signature' ORDER BY r.created_at, r.id`,
    [id.domain],
  );
  stored = rows.rows.map((r) => ({ receiptId: r.id, receiptPayloadText: r.receipt_payload }));
});

afterAll(async () => {
  // evidence.receipt is append-only; outside its trigger only the fixture's
  // pending rows go, so pgTAP 107 (no pending receipt, empty backlog) stays
  // true on a database it shares with this file.
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    "DELETE FROM evidence.receipt WHERE evidence_domain_id = $1 AND status = 'pending_signature'",
    [id.domain],
  );
  await admin.query("COMMIT");
  await Promise.all(pools.map((p) => p.end()));
  for (const user of Object.values(LOGIN)) await admin.query(`DROP ROLE IF EXISTS ${user}`);
  await admin.end();
});

describe("the web login cannot reach the worker's functions (S-1)", () => {
  it.each([
    ["app.worker_pending_backlog()", []],
    ["app.worker_pending_receipts($1::uuid, $2::integer, $3::uuid)", [id.domain, 10, null]],
    ["app.worker_receipt_keys($1::uuid)", [id.domain]],
  ])("%s is refused with 42501", async (call, values) => {
    await expect(app.query(`SELECT * FROM ${call}`, values)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("the adapters over the web login answer database_error, with no text", async () => {
    const failed = { status: "unavailable", reason: "database_error" };
    const queue = createPendingReceiptQueue(app);
    expect(await queue.backlog()).toStrictEqual(failed);
    expect(await queue.pendingReceipts(id.domain, 10, null)).toStrictEqual(failed);
    expect(await readReceiptKeys(app, id.domain)).toStrictEqual(failed);
  });
});

describe("the worker login reads the real pending receipts", () => {
  it("the commits were deferred: two pending receipts, no signature asked", () => {
    expect(signerCalls).toBe(0);
    expect(stored).toHaveLength(2);
  });

  it("backlog counts the domain's two receipts, with no id or text", async () => {
    const read = await createPendingReceiptQueue(worker).backlog();
    if (read.status !== "ok") throw new Error(`backlog: ${read.reason}`);
    const mine = read.rows.filter((r) => r.evidenceDomainId === id.domain);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual([
      "evidenceDomainId",
      "oldestCreatedAt",
      "pendingCount",
    ]);
    expect(mine[0]!.pendingCount).toBe(2);
    expect(mine[0]!.oldestCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("the list is the stored receipts in order, each a v2 payload of its own commit", async () => {
    const read = await createPendingReceiptQueue(worker).pendingReceipts(id.domain, 100, null);
    expect(read).toStrictEqual({ status: "ok", rows: stored });
    const byDocument = Object.fromEntries(students.map((who) => [documents[who], who]));
    for (const row of stored) {
      const payload: unknown = JSON.parse(row.receiptPayloadText);
      if (!isEvidenceReceiptPayloadV2(payload)) throw new Error("not a v2 payload");
      expect(canonicalizeJcs(payload)).toBe(row.receiptPayloadText);
      expect(payload.receiptId).toBe(row.receiptId);
      expect(payload.evidenceDomainId).toBe(id.domain);
      expect(payload.clientTransactionId).toBe(txid(byDocument[payload.documentId]!));
    }
  });

  it("the cursor walks one receipt at a time and ends empty", async () => {
    const queue = createPendingReceiptQueue(worker);
    const [first, second] = stored;
    expect(await queue.pendingReceipts(id.domain, 1, null)).toStrictEqual({
      status: "ok",
      rows: [first],
    });
    expect(await queue.pendingReceipts(id.domain, 1, first!.receiptId)).toStrictEqual({
      status: "ok",
      rows: [second],
    });
    expect(await queue.pendingReceipts(id.domain, 1, second!.receiptId)).toStrictEqual({
      status: "ok",
      rows: [],
    });
  });

  it("the domain's receipt keys read as EvidenceDomainKey", async () => {
    const read = await readReceiptKeys(worker, id.domain);
    const key = (k: number) => ({
      algorithm: "Ed25519",
      keyId: KEY_IDS[k],
      keyVersion: "1",
      encoding: "spki-der",
      keyBase64Url: spki(k),
      evidenceDomainId: id.domain,
      purpose: "receipt",
      validTo: null,
      revokedAt: null,
    });
    expect(read).toMatchObject({ status: "ok", keys: [key(0), key(1)] });
  });
});

/** The digest and an Ed25519 envelope of a stored pending receipt, under receipt key k. */
async function signed(row: { receiptPayloadText: string }, k: number) {
  const payload = JSON.parse(row.receiptPayloadText) as EvidenceReceiptPayloadV2;
  const digest = await digestEvidenceReceiptPayloadV2(payload);
  const signature: SignatureEnvelope = {
    algorithm: "Ed25519",
    keyId: KEY_IDS[k]!,
    keyVersion: "1",
    signatureEncoding: "raw",
    signatureBase64Url: sign(null, Buffer.from(digest.signingInput), KEYS[k]!.privateKey).toString(
      "base64url",
    ),
  };
  return { payload, payloadDigestSha256: digest.sha256, signature };
}
const statusOf = async (receiptId: string) =>
  (await admin.query("SELECT status FROM evidence.receipt WHERE id = $1", [receiptId])).rows[0]
    ?.status;

const ATTACH =
  "SELECT outcome, signature FROM app.worker_attach_receipt_signature($1::uuid, $2::text, $3::jsonb)";

/** True once the backend waits on a lock; false if it never does within five seconds. */
async function waitingOnLock(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 100; tries += 1) {
    const row = (
      await admin.query<{ wait: string | null }>(
        "SELECT wait_event_type AS wait FROM pg_catalog.pg_stat_activity WHERE pid = $1",
        [pid],
      )
    ).rows[0];
    if (row?.wait === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("the worker attaches a signature over real PostgreSQL (S-1, S-4)", () => {
  it("the web login cannot attach: 42501, and the receipt stays pending", async () => {
    const { payloadDigestSha256, signature } = await signed(stored[0]!, 0);
    await expect(
      app.query(
        "SELECT * FROM app.worker_attach_receipt_signature($1::uuid, $2::text, $3::jsonb)",
        [stored[0]!.receiptId, payloadDigestSha256, JSON.stringify(signature)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await createPendingReceiptStore(app).attachSignature({
        receiptId: stored[0]!.receiptId,
        payloadDigestSha256,
        signature,
      }),
    ).toStrictEqual({ outcome: "unavailable", reason: "database_error" });
    expect(await statusOf(stored[0]!.receiptId)).toBe("pending_signature");
  });

  it("a command the function refuses changes nothing", async () => {
    const store = createPendingReceiptStore(worker);
    const { payloadDigestSha256, signature } = await signed(stored[0]!, 0);
    const base = { receiptId: stored[0]!.receiptId, payloadDigestSha256, signature };
    // The adapter refuses a wrong digest form; the function refuses a short signature and a stale digest.
    expect(
      await store.attachSignature({ ...base, payloadDigestSha256: "AB".repeat(32) }),
    ).toStrictEqual({ outcome: "invalid" });
    expect(
      await store.attachSignature({
        ...base,
        signature: { ...signature, signatureBase64Url: "AAAA" },
      }),
    ).toStrictEqual({ outcome: "invalid" });
    expect(
      await store.attachSignature({ ...base, payloadDigestSha256: "0".repeat(64) }),
    ).toStrictEqual({ outcome: "digest_mismatch" });
    expect(await statusOf(stored[0]!.receiptId)).toBe("pending_signature");
  });

  it("two attaches at once: the second waits on the row lock, then answers already_signed with the first signature", async () => {
    const receiptId = stored[0]!.receiptId;
    const [a, b] = [await signed(stored[0]!, 0), await signed(stored[0]!, 1)];
    expect(a.signature.signatureBase64Url).not.toBe(b.signature.signatureBase64Url);
    // The first attach runs in a transaction held open, so it keeps the row
    // lock; the overlap is made, not left to the scheduler.
    const first = await worker.connect();
    const second = new pg.Pool({ connectionString: urlOf(LOGIN.worker), max: 1 });
    pools.push(second);
    try {
      await first.query("BEGIN");
      const held = await first.query(ATTACH, [
        receiptId,
        a.payloadDigestSha256,
        JSON.stringify(a.signature),
      ]);
      expect(held.rows).toEqual([{ outcome: "signed", signature: a.signature }]);
      const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const late = createPendingReceiptStore(second).attachSignature({
        receiptId,
        payloadDigestSha256: b.payloadDigestSha256,
        signature: b.signature,
      });
      // The second attach is inside the function and waits on the first one's lock.
      expect(await waitingOnLock(pid)).toBe(true);
      await first.query("COMMIT");
      expect(await late).toStrictEqual({ outcome: "already_signed", signature: a.signature });
    } finally {
      first.release();
    }
    const winner = a;
    // The stored signature verifies as a protocol 1 receipt under the domain's keys.
    const keys = await readReceiptKeys(worker, id.domain);
    if (keys.status !== "ok") throw new Error(`keys: ${keys.reason}`);
    const verified = await verifySignedEvidenceReceiptV2(
      winner,
      {
        documentId: winner.payload.documentId,
        clientTransactionId: winner.payload.clientTransactionId,
        revision: 1,
        evidenceDomainId: id.domain,
      },
      keys.keys,
    );
    expect(verified.ok).toBe(true);
    expect(await statusOf(receiptId)).toBe("signed");
    const left = await createPendingReceiptQueue(worker).pendingReceipts(id.domain, 100, null);
    expect(left).toStrictEqual({ status: "ok", rows: [stored[1]] });
  });
});

/** What the database holds for a document, read by the administrator. */
async function stateOf(documentId: string) {
  const { rows } = await admin.query<Record<string, string>>(
    `SELECT d.current_revision::text AS revision,
            (SELECT count(*) FROM evidence.document_revision r WHERE r.document_id = d.id)::text AS revisions,
            (SELECT count(*) FROM evidence.segment s WHERE s.document_id = d.id)::text AS segments,
            (SELECT count(*) FROM evidence.receipt r JOIN evidence.package p ON p.id = r.evidence_package_id
              WHERE p.document_id = d.id)::text AS receipts
       FROM evidence.document d WHERE d.id = $1`,
    [documentId],
  );
  return rows[0];
}

/** The document's jobs in the worker's queue (DAN-820): its pending receipts as the worker reads them. */
async function queuedFor(documentId: string) {
  const read = await createPendingReceiptQueue(worker).pendingReceipts(id.domain, 100, null);
  if (read.status !== "ok") throw new Error(`queue: ${read.reason}`);
  return read.rows.filter((row) => JSON.parse(row.receiptPayloadText).documentId === documentId);
}
const heldFor = async (documentId: string) => ({
  state: await stateOf(documentId),
  queued: await queuedFor(documentId),
});

// DAN-821-1 (contract Ductus#1836 c.6942953478): the same key and the same
// bytes make one revision and one job in the worker's queue, while the
// receipt waits and after the worker signed it. Here ana is signed, iva pending.
describe("deferred commit: the same key and bytes make one revision and one job (DAN-821)", () => {
  const committer = () => createEvidenceCommitter(withActor, signer);

  it("N1: the same key with another segment while the receipt waits is txid_reused and changes nothing", async () => {
    const input = firstInputs.iva!;
    const before = await heldFor(input.documentId);
    const segmentHash = sha256(`drugi segment ${txid("iva")}`);
    const other = {
      ...input,
      descriptor: { ...input.descriptor, segmentHash },
      storageRef: input.storageRef.replace(input.descriptor.segmentHash, segmentHash),
    };
    expect(await committer().commit(token.iva, other, "deferred")).toEqual({
      status: "txid_reused",
    });
    expect(await heldFor(input.documentId)).toStrictEqual(before);
    expect(JSON.parse(before.queued[0]!.receiptPayloadText).segmentHash).toBe(
      input.descriptor.segmentHash,
    );
    expect(signerCalls).toBe(0);
  });

  it("N2: the same request under protocol 1 while the receipt waits is a closed fault and signs nothing", async () => {
    const input = firstInputs.iva!;
    const before = await heldFor(input.documentId);
    expect(await committer().commit(token.iva, input, "inline")).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "duplicate_pending",
    });
    expect(await heldFor(input.documentId)).toStrictEqual(before);
    expect(signerCalls).toBe(0);
  });

  it("P1: the same request while the receipt waits is duplicate_pending, one revision and one job", async () => {
    const input = firstInputs.iva!;
    const queued = await queuedFor(input.documentId);
    expect(queued).toHaveLength(1);
    expect(await committer().commit(token.iva, input, "deferred")).toEqual({
      status: "duplicate_pending",
      revision: 1,
    });
    expect(await stateOf(input.documentId)).toEqual({
      revision: "1",
      revisions: "2",
      segments: "1",
      receipts: "1",
    });
    expect(await queuedFor(input.documentId)).toStrictEqual(queued);
    expect(signerCalls).toBe(0);
  });

  it("P2: two identical requests at once make one revision and one job, one committed and one duplicate", async () => {
    const first = firstInputs.iva!;
    const snapshot = JSON.stringify({ naslov: "Izmišljeni drugi odlomak iva." });
    const segmentHash = sha256(`segment ${txid("iva")}-2`);
    const input: EvidenceCommitInput = {
      ...first,
      clientTransactionId: `${txid("iva")}-2`,
      baseRevision: 1,
      initialDocumentHash: first.finalDocumentHash,
      finalDocumentHash: sha256(snapshot),
      descriptor: {
        ...first.descriptor,
        segmentId: "segment-iva-2",
        sequenceFrom: 2,
        sequenceTo: 2,
        segmentHash,
        predecessorSegmentHash: first.descriptor.segmentHash,
      },
      storageRef: first.storageRef.replace(first.descriptor.segmentHash, segmentHash),
      snapshot,
    };
    // The administrator holds the package, so both requests wait in the RPC
    // and the overlap is made, not left to the scheduler.
    const holder = await admin.connect();
    let both: Promise<unknown[]>;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM evidence.package WHERE document_id = $1 FOR UPDATE", [
        first.documentId,
      ]);
      both = Promise.all([
        committer().commit(token.iva, input, "deferred"),
        committer().commit(token.iva, input, "deferred"),
      ]);
      let waiting = 0;
      for (let tries = 0; tries < 100 && waiting < 2; tries += 1) {
        const row = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
            WHERE usename = $1 AND wait_event_type = 'Lock'`,
          [LOGIN.app],
        );
        waiting = row.rows[0]!.n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(2);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      holder.release();
    }
    const outcomes = (await both) as { status: string; revision: number }[];
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "committed_pending",
      "duplicate_pending",
    ]);
    for (const outcome of outcomes) expect(outcome.revision).toBe(2);
    expect(await stateOf(first.documentId)).toEqual({
      revision: "2",
      revisions: "3",
      segments: "2",
      receipts: "2",
    });
    const queued = await queuedFor(first.documentId);
    expect(queued.map((row) => JSON.parse(row.receiptPayloadText).clientTransactionId)).toEqual([
      txid("iva"),
      input.clientTransactionId,
    ]);
    expect(signerCalls).toBe(0);
  });

  it("P3: after the worker signed, the same request is the stored signed receipt, under either protocol", async () => {
    const input = firstInputs.ana!;
    const { rows } = await admin.query<{ status: string; signature: unknown }>(
      `SELECT r.status, r.signature FROM evidence.receipt r JOIN evidence.package p ON p.id = r.evidence_package_id
        WHERE p.document_id = $1`,
      [input.documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("signed");
    const before = await heldFor(input.documentId);
    expect(before.queued).toEqual([]);
    for (const signing of ["deferred", "inline"] as const) {
      const again = await committer().commit(token.ana, input, signing);
      expect(again).toMatchObject({ status: "duplicate", revision: 1 });
      expect(again.status === "duplicate" && again.signedReceipt.signature).toEqual(
        rows[0]!.signature,
      );
    }
    expect(await heldFor(input.documentId)).toStrictEqual(before);
    expect(signerCalls).toBe(0);
  });
});

// DAN-821-2 (contract Ductus#1836 c.6943581351): the segment, the revision and
// the job (the pending receipt) come from one RPC in one transaction, so a
// fault after the RPC returned leaves none of them, and the same request then
// makes exactly one of each. ana's revision 1 is signed; this is her segment 2.
describe("deferred commit: the segment and its job are made together or not at all (DAN-821)", () => {
  let input: EvidenceCommitInput;
  beforeAll(() => {
    const first = firstInputs.ana!;
    const snapshot = JSON.stringify({ naslov: "Izmišljeni drugi odlomak ana." });
    const segmentHash = sha256(`segment ${txid("ana")}-2`);
    input = {
      ...first,
      clientTransactionId: `${txid("ana")}-2`,
      baseRevision: 1,
      initialDocumentHash: first.finalDocumentHash,
      finalDocumentHash: sha256(snapshot),
      descriptor: {
        ...first.descriptor,
        segmentId: "segment-ana-2",
        sequenceFrom: 2,
        sequenceTo: 2,
        segmentHash,
        predecessorSegmentHash: first.descriptor.segmentHash,
      },
      storageRef: first.storageRef.replace(first.descriptor.segmentHash, segmentHash),
      snapshot,
    };
  });

  it("A1: a fault in the transaction after the RPC returned leaves no revision, segment or job", async () => {
    const before = await heldFor(input.documentId);
    let returned = false;
    const faulty: WithActor = (who, fn) =>
      withActor(who, async (tx) => {
        await fn(tx);
        returned = true;
        throw new Error("izmišljeni pad prije COMMIT-a");
      });
    expect(
      await createEvidenceCommitter(faulty, signer).commit(token.ana, input, "deferred"),
    ).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "commit_failed",
    });
    expect(returned).toBe(true);
    expect(await heldFor(input.documentId)).toStrictEqual(before);
    expect(signerCalls).toBe(0);
  });

  it("A2: the commit's own check failing after the RPC leaves no revision, segment or job", async () => {
    const before = await heldFor(input.documentId);
    const tampered: WithActor = (who, fn) =>
      withActor(who, (tx) =>
        fn({
          async query<Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) {
            const answer = await tx.query<Row>(text, values);
            if (!text.includes("app.commit_evidence_segment")) return answer;
            const rows = answer.rows.map((row) => ({ ...row, receipt_id: randomUUID() }) as Row);
            return { ...answer, rows };
          },
        }),
      );
    expect(
      await createEvidenceCommitter(tampered, signer).commit(token.ana, input, "deferred"),
    ).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "receipt_mismatch",
    });
    expect(await heldFor(input.documentId)).toStrictEqual(before);
    expect(signerCalls).toBe(0);
  });

  it("A3: the same request then makes exactly one revision, one segment and one job", async () => {
    const before = await heldFor(input.documentId);
    expect(before.queued).toEqual([]);
    expect(
      await createEvidenceCommitter(withActor, signer).commit(token.ana, input, "deferred"),
    ).toEqual({
      status: "committed_pending",
      revision: 2,
    });
    const after = await heldFor(input.documentId);
    const plusOne = (value: string | undefined) => String(Number(value) + 1);
    expect(after.state).toEqual({
      revision: "2",
      revisions: plusOne(before.state?.revisions),
      segments: plusOne(before.state?.segments),
      receipts: plusOne(before.state?.receipts),
    });
    expect(
      after.queued.map((row) => JSON.parse(row.receiptPayloadText).clientTransactionId),
    ).toEqual([input.clientTransactionId]);
    expect(signerCalls).toBe(0);
  });
});
