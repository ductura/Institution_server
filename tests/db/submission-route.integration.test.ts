import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createActorReader,
  createSettingsWriter,
  createWebAuthnCredentials,
  createWithActor,
  createWorkOpener,
  readReceiptKeys,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  digestSubmissionReceiptPayloadV2,
  type EvidenceDomainKey,
  isSignedSubmissionReceiptV2,
  type JcsJsonValue,
  REVISION_ZERO_JCS,
  REVISION_ZERO_NODE_ID,
  REVISION_ZERO_SHA256,
} from "../../server/domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
  type SigningKeyProvider,
} from "../../server/external/keys/index.ts";
import {
  createEditStepsV1Replayer,
  InMemoryEvidencePayloadStore,
} from "../../server/external/storage/index.ts";
import {
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createLayers,
  createStudentSubmissionRoutesFor,
  createSubmissionRouteFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// SRV-18 (Ductus#2028): POST /api/v1/submission through a real server over
// real PostgreSQL with RLS, a ductus_app login, the development signer
// (NODE_ENV test only) and payload storage in memory. Each work is written
// through the real open and commit routes, from revision 0, with invented
// text; the submission then reconstructs it. The time of a submission is the
// database's. Every institution, person, token, text and key is random and
// synthetic; the logins exist only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_submission_route_app";
const WORKER_LOGIN = "it_submission_route_worker";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const PATH = "/api/v1/submission";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const STUDENTS = ["ana", "bruno", "cvita", "dora", "ema"] as const;
type Student = (typeof STUDENTS)[number];
const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  // SRV-22: an assignment of k1 with a word range, and one of a course without students.
  z2: randomUUID(),
  k2: randomUUID(),
  z3: randomUUID(),
  domainA: randomUUID(),
};
const user = Object.fromEntries(STUDENTS.map((s) => [s, randomUUID()])) as Record<Student, string>;
const token = Object.fromEntries(
  STUDENTS.map((s) => [s, randomBytes(32).toString("base64url")]),
) as Record<Student, string>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The seed lives outside the repository, as the signer demands.
const seedDir = mkdtempSync(join(tmpdir(), "srv18-submission-"));
const SEED = join(seedDir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
const real = new PersistentDevelopmentEd25519SigningKeyProvider(
  { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED },
  ROOT,
);
/** The signer of the server: down while `outage` holds, for commit and submission alike. */
let outage = false;
const down = () => Promise.reject(new Error("signer_down_for_test"));
const signer: SigningKeyProvider = {
  sign: (message) => (outage ? down() : real.sign(message)),
  verify: (message, signature) => (outage ? down() : real.verify(message, signature)),
  publicVerificationKey: () => (outage ? down() : real.publicVerificationKey()),
};
const payloads = new InMemoryEvidencePayloadStore();

type GoldenSegment = Record<string, unknown> & { events: Record<string, unknown>[] };
const { chain } = JSON.parse(
  readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
) as { chain: { segments: { segment: GoldenSegment }[] } };

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let worker: pg.Pool;
let server: Running;

async function createLogin(login: string, role: string): Promise<pg.Pool> {
  await admin.query(`DROP ROLE IF EXISTS ${login}`);
  const ddl = await admin.query<{ ddl: string }>(
    `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ${role}', $1::text, $2::text) AS ddl`,
    [login, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  const url = new URL(ADMIN_URL);
  url.username = login;
  url.password = password;
  return new pg.Pool({ connectionString: url.href, max: 4 });
}

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    id.a,
    `it-sub-${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Izmišljeni fakultet (test)', 5, '15 minutes')`,
    [id.a],
  );
  const accounts: [string, string][] = [
    [id.adminA, "adminA"],
    [id.vesna, "vesna"],
    ...STUDENTS.map((s) => [user[s], s] as [string, string]),
  ];
  for (const [account, name] of accounts) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.example.invalid', $3, $4)`,
      [account, id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const s of STUDENTS) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[s], user[s], id.a],
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
     VALUES ($1, $2, 'Izmišljeni kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'teacher' UNION ALL SELECT $1::uuid, $2::uuid, unnest($4::uuid[]), 'student'`,
    [id.k1, id.a, id.vesna, STUDENTS.map((s) => user[s])],
  );
  await q(
    `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
     VALUES ($1, $2, $3, 1, $4)`,
    [id.z1, id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
       opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
     VALUES ($1, 1, 'Izmišljeni zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
       now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
    [id.z1, id.vesna],
  );
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Drugi izmišljeni kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k2, id.a, id.vesna],
  );
  for (const [assignment, course, min, max] of [
    [id.z2, id.k1, 800, 1200],
    [id.z3, id.k2, null, null],
  ] as const) {
    await q(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
       VALUES ($1, $2, $3, 1, $4)`,
      [assignment, course, id.a, id.vesna],
    );
    await q(
      `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
         opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by,
         word_min, word_max)
       VALUES ($1, 1, 'Drugi izmišljeni zadatak (test)', 'Upute.', 'essay', now(),
         now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2, $3, $4)`,
      [assignment, id.vesna, min, max],
    );
  }
  await q(
    `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
     SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
    [id.z1, STUDENTS.map((s) => user[s]), id.a],
  );
  await q(
    "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, $2, 'eu-central-1')",
    [id.domainA, id.a],
  );
  const key = await real.publicVerificationKey();
  if (!key.ok) throw new Error("development key");
  await q(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     VALUES ($1, $2, $3, $4, 'receipt', 'Ed25519', $5, date_trunc('minute', now()) - interval '1 day')`,
    [key.value.keyId, key.value.keyVersion, id.domainA, id.a, key.value.keyBase64Url],
  );
  await q("COMMIT");
}

beforeAll(async () => {
  app = await createLogin(APP_LOGIN, "ductus_app");
  worker = await createLogin(WORKER_LOGIN, "ductus_worker");
  await fixture();
  const withActor = createWithActor(app);
  const main = {
    withActor,
    actorReader: createActorReader(withActor),
    workOpener: createWorkOpener(withActor),
    settingsWriter: createSettingsWriter(withActor),
    webauthnCredentials: createWebAuthnCredentials(withActor),
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createEvidenceOpenRoute(main),
      createEvidenceCommitRouteFor(main, { signer, payloads }),
      createSubmissionRouteFor(main, { signer, payloads }),
      ...createStudentSubmissionRoutesFor(main),
    ],
  });
});

afterAll(async () => {
  await server?.close();
  await worker?.end();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${WORKER_LOGIN}`);
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
  rmSync(seedDir, { recursive: true, force: true });
});

type Answer = {
  status: number;
  text: string;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};
function post(path: string, body: unknown, who: Student, raw?: string): Promise<Answer> {
  const text = raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path,
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "ductus-protocol": "1",
          cookie: `__Host-ductus_session=${token[who]}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: data,
            body: data === "" ? {} : (JSON.parse(data) as Record<string, unknown>),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

type Edit = { source: string; text: string };
type Work = { documentId: string; revision: number };

/**
 * Opens the student's work and commits each group of edits as one segment,
 * chained from revision 0. Every edit inserts invented text at the start of
 * the first paragraph; the hashes are those of the server's own replayer.
 */
async function write(who: Student, segments: readonly (readonly Edit[])[]): Promise<Work> {
  const opened = await post("/api/v1/evidence/open", { assignmentId: id.z1, start: true }, who);
  expect(opened.status).toBe(200);
  const { documentId, documentHash, evidenceProfileId } = opened.body as {
    documentId: string;
    documentHash: string;
    evidenceProfileId: string;
  };
  expect(documentHash).toBe(REVISION_ZERO_SHA256);
  const replayer = createEditStepsV1Replayer();
  let document = replayer.load(JSON.parse(REVISION_ZERO_JCS) as JcsJsonValue);
  let documentText = REVISION_ZERO_JCS;
  let predecessor: string | null = null;
  let sequence = 0;
  let revision = 0;
  for (const [index, edits] of segments.entries()) {
    const template = chain.segments[Math.min(index, chain.segments.length - 1)]!.segment;
    const initial = sha256(documentText);
    const events = edits.map((edit) => {
      sequence += 1;
      const before = sha256(documentText);
      const event = {
        sequence,
        source: edit.source,
        steps: [
          {
            stepType: "replace",
            from: 1,
            to: 1,
            slice: { content: [{ type: "text", text: edit.text }] },
          },
        ],
        touchedNodeIds: [REVISION_ZERO_NODE_ID],
        beforeDocumentHash: before,
        afterDocumentHash: "",
      };
      document = replayer.apply(document, event as never);
      documentText = canonicalizeJcs(replayer.toCanonical(document));
      event.afterDocumentHash = sha256(documentText);
      return event;
    });
    const segment = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${who}-${suffix}`,
      segmentId: `segment-${who}-${suffix}-${index + 1}`,
      sequenceFrom: events[0]!.sequence,
      sequenceTo: events.at(-1)!.sequence,
      initialDocumentHash: initial,
      finalDocumentHash: sha256(documentText),
      predecessorSegmentHash: predecessor,
      evidenceProfileId,
      events,
    } as unknown as JcsJsonValue);
    const committed = await post(
      "/api/v1/evidence/commit",
      {
        documentId,
        clientTransactionId: `tx-${who}-${suffix}-${index + 1}`,
        baseRevision: revision,
        segments: [Buffer.from(segment, "utf8").toString("base64")],
        document: Buffer.from(documentText, "utf8").toString("base64"),
      },
      who,
    );
    expect(committed.status, committed.text).toBe(200);
    expect(committed.body).toMatchObject({ status: "committed", receipt: { status: "signed" } });
    revision = committed.body.revision as number;
    predecessor = sha256(segment);
  }
  return { documentId, revision };
}

/** The receipt checked against the domain's keys as the worker reads them (receipt-keys.ts). */
async function expectVerifiable(receipt: unknown): Promise<void> {
  expect(isSignedSubmissionReceiptV2(receipt)).toBe(true);
  if (!isSignedSubmissionReceiptV2(receipt)) return;
  const digest = await digestSubmissionReceiptPayloadV2(receipt.payload);
  expect(receipt.payloadDigestSha256).toBe(sha256(canonicalizeJcs(receipt.payload as never)));
  expect(receipt.payloadDigestSha256).toBe(digest.sha256);
  const keys = await readReceiptKeys(worker, receipt.payload.evidenceDomainId);
  if (keys.status !== "ok") throw new Error(`receipt keys: ${keys.reason}`);
  const list: readonly EvidenceDomainKey[] = keys.keys;
  const key = list.find(
    (k) => k.keyId === receipt.signature.keyId && k.keyVersion === receipt.signature.keyVersion,
  );
  expect(key).toBeDefined();
  const publicKey = createPublicKey({
    key: Buffer.from(key!.keyBase64Url, "base64url"),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(receipt.signature.signatureBase64Url, "base64url");
  expect(verify(null, digest.signingInput, publicKey, signature)).toBe(true);
}

/** The receipts bound to the student's submissions (one per submission, keyed by it). */
const receiptRows = async (who: Student) =>
  (
    await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM evidence.submission_receipt WHERE principal_id = $1",
      [user[who]],
    )
  ).rows[0]!.n;

describe("POST /api/v1/submission over submitWork (SRV-18)", () => {
  let ana: Work;

  it("submits: 200 with a receipt v2 whose signature verifies under the domain's key and whose digest is SHA-256 of the payload's JCS", async () => {
    ana = await write("ana", [
      [
        { source: "editor", text: "Izmišljeni uvod o kišnici. " },
        { source: "editor", text: "Druga izmišljena rečenica. " },
      ],
    ]);
    const answer = await post(PATH, ana, "ana");
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.status).toBe("submitted");
    const receipt = answer.body.receipt as { payload: Record<string, unknown> };
    expect(receipt.payload).toMatchObject({
      receiptSchema: "ductus-submission-receipt-v2",
      documentId: ana.documentId,
      revision: ana.revision,
      assignmentId: id.z1,
      principalId: user.ana,
      evidenceDomainId: id.domainA,
      evidenceRecord: "continuous",
      afterDeadline: false,
    });
    await expectVerifiable(answer.body.receipt);
  });

  it("the same revision again answers the same bytes; another revision is 409 already_requested", async () => {
    const first = await post(PATH, ana, "ana");
    const again = await post(PATH, ana, "ana");
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect(await receiptRows("ana")).toBe("1");
    const other = await post(PATH, { ...ana, revision: ana.revision + 1 }, "ana");
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ status: "already_requested", revision: ana.revision });
  });

  it("a notice not acknowledged is 409 not_acknowledged", async () => {
    // Open asks for the acknowledgment too, so cvita opens her work first and
    // the acknowledgment is then taken away, as the fixture's owner.
    const opened = await post(
      "/api/v1/evidence/open",
      { assignmentId: id.z1, start: true },
      "cvita",
    );
    expect(opened.status, opened.text).toBe(200);
    const documentId = opened.body.documentId as string;
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      "DELETE FROM institution.notice_acknowledgment WHERE assignment_id = $1 AND student_id = $2",
      [id.z1, user.cvita],
    );
    await admin.query("COMMIT");
    const answer = await post(PATH, { documentId, revision: 0 }, "cvita");
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ status: "not_acknowledged" });
  });

  it("another student's work is 404, never told apart from a missing one", async () => {
    const theirs = await post(PATH, ana, "dora");
    expect(theirs.status).toBe(404);
    const missing = await post(PATH, { documentId: `nema-${suffix}`, revision: 1 }, "dora");
    expect(missing.status).toBe(404);
    expect(theirs.text).toBe(missing.text);
  });

  it("a field outside {documentId, revision} is 422 and a body over 1 KiB is 413, before the port", async () => {
    const extra = await post(PATH, { ...ana, submittedAt: "2026-11-19T10:00:00Z" }, "ana");
    expect(extra.status).toBe(422);
    const big = await post(
      PATH,
      undefined,
      "ana",
      JSON.stringify({ ...ana, pad: "x".repeat(1100) }),
    );
    expect(big.status).toBe(413);
  });

  it("the signer down is 503 signing with retry-after 5; the same revision after recovery is 200 and the receipt is bound once", async () => {
    const bruno = await write("bruno", [[{ source: "editor", text: "Izmišljeni osvrt na vrt. " }]]);
    outage = true;
    let refused: Answer;
    try {
      refused = await post(PATH, bruno, "bruno");
    } finally {
      outage = false;
    }
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ status: "unavailable", stage: "signing" });
    expect(refused.headers["retry-after"]).toBe("5");
    expect(await receiptRows("bruno")).toBe("0");
    const recovered = await post(PATH, bruno, "bruno");
    expect(recovered.status, recovered.text).toBe(200);
    await expectVerifiable(recovered.body.receipt);
    const again = await post(PATH, bruno, "bruno");
    expect(again.text).toBe(recovered.text);
    expect(await receiptRows("bruno")).toBe("1");
  });

  it("rule 11: a work with a paste and with edits of no recorded origin is submitted, 200", async () => {
    const dora = await write("dora", [
      [
        { source: "editor", text: "Izmišljeni tekst o kompostu. " },
        { source: "paste", text: "Zalijepljeni izmišljeni odlomak. " },
      ],
      [
        { source: "keyless-input", text: "Unos bez tipkovnice. " },
        { source: "unattributed", text: "Promjena bez zabilježenog podrijetla. " },
      ],
    ]);
    const answer = await post(PATH, dora, "dora");
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.status).toBe("submitted");
    await expectVerifiable(answer.body.receipt);
  });
});

/** A GET of the student's own read under /api/v1/student/assignments. */
function get(path: string, who: Student | null): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: `/api/v1/student/assignments/${path}`,
        headers: {
          "sec-fetch-site": "same-origin",
          ...(who === null ? {} : { cookie: `__Host-ductus_session=${token[who]}` }),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: data,
            body: JSON.parse(data) as Record<string, unknown>,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const withoutRequestId = ({ requestId: _id, ...body }: Record<string, unknown>) => body;

describe("GET the student's submission state and word range (SRV-22)", () => {
  it("none, then ceka after 503 signing, then potvrdeno with the same receipt bytes the submission answered", async () => {
    expect((await get(`${id.z1}/submission`, "ema")).text).toBe('{"state":"none"}');
    const ema = await write("ema", [[{ source: "editor", text: "Izmišljena bilješka o tlu. " }]]);
    expect((await get(`${id.z1}/submission`, "ema")).text).toBe('{"state":"none"}');
    outage = true;
    try {
      expect((await post(PATH, ema, "ema")).status).toBe(503);
    } finally {
      outage = false;
    }
    const waiting = await get(`${id.z1}/submission`, "ema");
    expect(waiting.status, waiting.text).toBe(200);
    expect(waiting.body).toEqual({
      state: "ceka",
      revision: ema.revision,
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
    });
    const submitted = await post(PATH, ema, "ema");
    expect(submitted.status, submitted.text).toBe(200);
    const prefix = '{"status":"submitted","receipt":';
    expect(submitted.text.startsWith(prefix)).toBe(true);
    const receiptText = submitted.text.slice(prefix.length, -1);
    const bound = await get(`${id.z1}/submission`, "ema");
    expect(bound.status).toBe(200);
    expect(bound.text).toBe(`{"state":"potvrdeno","receipt":${receiptText}}`);
    await expectVerifiable(bound.body.receipt);
    // The request instant ceka showed is the one the receipt signs: one submission.
    const receipt = bound.body.receipt as { payload: { requestedAt: string } };
    expect(receipt.payload.requestedAt).toBe(waiting.body.requestedAt);
    expect((await get(`${id.z1}/submission`, "ema")).text).toBe(bound.text);
  });

  it("an assignment of another course, an unknown and a malformed id are the same 404", async () => {
    const answers = await Promise.all(
      [`${id.z3}/submission`, `${randomUUID()}/submission`, "nije-uuid/submission"].map((path) =>
        get(path, "ana"),
      ),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(withoutRequestId(answer.body)).toEqual(withoutRequestId(answers[0]!.body));
    }
    expect((await get(`${id.z3}/requirements`, "ana")).status).toBe(404);
  });

  it("no session is 401", async () => {
    expect((await get(`${id.z1}/submission`, null)).status).toBe(401);
    expect((await get(`${id.z1}/requirements`, null)).status).toBe(401);
  });

  it("the word range of the current version: none set is null, both set are min and max", async () => {
    const none = await get(`${id.z1}/requirements`, "ana");
    expect(none.status, none.text).toBe(200);
    expect(none.text).toBe('{"wordRange":null}');
    const range = await get(`${id.z2}/requirements`, "ana");
    expect(range.text).toBe('{"wordRange":{"min":800,"max":1200}}');
  });
});
