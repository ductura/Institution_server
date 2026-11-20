import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createActorReader,
  createMyAccessLogReader,
  createSettingsWriter,
  createWebAuthnCredentials,
  createWithActor,
  createWorkOpener,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  type JcsJsonValue,
  REVISION_ZERO_JCS,
  REVISION_ZERO_NODE_ID,
} from "../../server/domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
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
  createProcessSummaryRouteFor,
  createSubmissionRouteFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// SRV-23 (Ductus#2028): POST /api/v1/process-summary through a real server
// over real PostgreSQL with RLS and a ductus_app login. The student's work is
// written through the real open and commit routes with invented text and
// submitted; the owner and the teacher of the course then read the same
// bytes, a student or teacher with no relation to the work gets the 404 of a
// missing one, and only the teacher's read leaves a process_summary row in
// the student's access log. Every institution, person, token, text and key is
// random and synthetic; the login exists only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_process_summary_route_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const PATH = "/api/v1/process-summary";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const PEOPLE = ["ana", "bruno", "vesna", "marko"] as const;
type Person = (typeof PEOPLE)[number];
const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  k1: randomUUID(),
  k2: randomUUID(),
  z1: randomUUID(),
  domainA: randomUUID(),
};
const user = Object.fromEntries(PEOPLE.map((p) => [p, randomUUID()])) as Record<Person, string>;
const token = Object.fromEntries(
  PEOPLE.map((p) => [p, randomBytes(32).toString("base64url")]),
) as Record<Person, string>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const seedDir = mkdtempSync(join(tmpdir(), "srv23-process-summary-"));
const SEED = join(seedDir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
  { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED },
  ROOT,
);
const payloads = new InMemoryEvidencePayloadStore();

type GoldenSegment = Record<string, unknown> & { events: Record<string, unknown>[] };
const { chain } = JSON.parse(
  readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
) as { chain: { segments: { segment: GoldenSegment }[] } };

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;
let main: { withActor: ReturnType<typeof createWithActor> };

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [id.a, `it-ps-${suffix}`]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Izmišljeni fakultet (test)', 5, '15 minutes')`,
    [id.a],
  );
  for (const [account, name] of [[id.adminA, "adminA"], ...PEOPLE.map((p) => [user[p], p])]) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.example.invalid', $3, $4)`,
      [account, id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const p of PEOPLE) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[p], user[p], id.a],
    );
  }
  await q("SELECT institution.appoint_institution_admin($1, $2)", [id.adminA, `Zahtjev ${suffix}`]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     SELECT $1::uuid, unnest($2::uuid[]), 'teacher', $3::uuid, now()`,
    [id.a, [user.vesna, user.marko], id.adminA],
  );
  // Vesna teaches k1 with both students; Marko teaches only k2 (no relation to the work).
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $3, 'Izmišljeni kolegij (test)', '2026/2027', 'partially_allowed', $4),
            ($2, $3, 'Drugi izmišljeni kolegij (test)', '2026/2027', 'partially_allowed', $5)`,
    [id.k1, id.k2, id.a, user.vesna, user.marko],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     VALUES ($1, $3, $4, 'teacher'), ($1, $3, $5, 'student'), ($1, $3, $6, 'student'),
            ($2, $3, $7, 'teacher')`,
    [id.k1, id.k2, id.a, user.vesna, user.ana, user.bruno, user.marko],
  );
  await q(
    `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
     VALUES ($1, $2, $3, 1, $4)`,
    [id.z1, id.k1, id.a, user.vesna],
  );
  await q(
    `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
       opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
     VALUES ($1, 1, 'Izmišljeni zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
       now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
    [id.z1, user.vesna],
  );
  await q(
    `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
     SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
    [id.z1, [user.ana, user.bruno], id.a],
  );
  await q(
    "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, $2, 'eu-central-1')",
    [id.domainA, id.a],
  );
  const key = await signer.publicVerificationKey();
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
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 4 });
  await fixture();
  const withActor = createWithActor(app);
  main = { withActor };
  const databases = {
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
      createEvidenceOpenRoute(databases),
      createEvidenceCommitRouteFor(databases, { signer, payloads }),
      createSubmissionRouteFor(databases, { signer, payloads }),
      createProcessSummaryRouteFor(databases, { payloads }, {}),
    ],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
  rmSync(seedDir, { recursive: true, force: true });
});

type Answer = { status: number; text: string; body: Record<string, unknown> };
function post(path: string, body: unknown, who: Person): Promise<Answer> {
  const text = JSON.stringify(body);
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
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

/** Opens Ana's work and commits each group of edits as one segment, chained from revision 0. */
async function write(segments: readonly (readonly { source: string; text: string }[])[]) {
  const opened = await post("/api/v1/evidence/open", { assignmentId: id.z1, start: true }, "ana");
  expect(opened.status, opened.text).toBe(200);
  const { documentId, evidenceProfileId } = opened.body as {
    documentId: string;
    evidenceProfileId: string;
  };
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
        beforeDocumentHash: sha256(documentText),
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
      sessionId: `sesija-ana-${suffix}`,
      segmentId: `segment-ana-${suffix}-${index + 1}`,
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
        clientTransactionId: `tx-ana-${suffix}-${index + 1}`,
        baseRevision: revision,
        segments: [Buffer.from(segment, "utf8").toString("base64")],
        document: Buffer.from(documentText, "utf8").toString("base64"),
      },
      "ana",
    );
    expect(committed.status, committed.text).toBe(200);
    revision = committed.body.revision as number;
    predecessor = sha256(segment);
  }
  return { documentId, revision };
}

const accessLog = async (documentId: string) => {
  const page = await createMyAccessLogReader(main.withActor).read(token.ana, documentId);
  if (!page.ok) throw new Error("access log");
  return page.value.entries.map((entry) => entry.surface);
};

describe("POST /api/v1/process-summary over the reader and PostgreSQL (SRV-23)", () => {
  let documentId: string;

  beforeAll(async () => {
    const work = await write([
      [
        { source: "editor", text: "Izmišljeni uvod o kućnom kompostu. " },
        { source: "paste", text: "Zalijepljeni izmišljeni odlomak. " },
      ],
      [{ source: "editor", text: "Druga izmišljena rečenica. " }],
    ]);
    documentId = work.documentId;
    const submitted = await post("/api/v1/submission", work, "ana");
    expect(submitted.status, submitted.text).toBe(200);
  });

  it("the owner's read is the summary and writes no row of the access log", async () => {
    const own = await post(PATH, { documentId }, "ana");
    expect(own.status, own.text).toBe(200);
    expect(own.body).toMatchObject({ summaryFormat: "ductus-process-summary-v1" });
    expect(own.text).toBe(canonicalizeJcs(own.body as JcsJsonValue));
    expect(await accessLog(documentId)).toEqual([]);
  });

  it("the teacher of the course reads the same bytes, and the student's access log shows process_summary", async () => {
    const own = await post(PATH, { documentId }, "ana");
    const teacher = await post(PATH, { documentId }, "vesna");
    expect(teacher.status, teacher.text).toBe(200);
    expect(teacher.text).toBe(own.text);
    expect(await accessLog(documentId)).toEqual(["process_summary"]);
    // A second read in the same interval adds no row.
    await post(PATH, { documentId }, "vesna");
    expect(await accessLog(documentId)).toEqual(["process_summary"]);
  });

  it("another student and a teacher of another course get the 404 of a missing work, and leave no row", async () => {
    const missing = await post(PATH, { documentId: `nema-${suffix}` }, "bruno");
    expect(missing.status).toBe(404);
    for (const who of ["bruno", "marko"] as const) {
      const theirs = await post(PATH, { documentId }, who);
      expect(theirs.status).toBe(404);
      expect(theirs.body.code).toBe(missing.body.code);
    }
    expect(await accessLog(documentId)).toEqual(["process_summary"]);
  });
});
