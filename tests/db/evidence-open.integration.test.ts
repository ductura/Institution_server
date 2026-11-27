import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import { Value } from "@sinclair/typebox/value";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import {
  createActorReader,
  createWithActor,
  createWorkOpener,
} from "../../server/database/index.ts";
import {
  createDatabases,
  createEvidenceOpenRoute,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-811, plan of attack ductura/server#107 parts C and D: POST
// /api/v1/evidence/open on a real server over real PostgreSQL with RLS, through
// a ductus_app login as in production. Every institution, person, course,
// token and key is random and synthetic; the login exists only while this
// file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_open_app";
const ORIGIN = "https://ductura.example.invalid";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const contract = ROUTES.find((route) => route.id === "evidence.open.post");
if (contract === undefined) throw new Error("no contract");
const OPENED_SCHEMA = contract.responses[0]!.body!;

const id = {
  a: randomUUID(),
  b: randomUUID(),
  adminA: randomUUID(),
  adminB: randomUUID(),
  vesna: randomUUID(),
  petra: randomUUID(),
  ana: randomUUID(),
  dora: randomUUID(),
  eva: randomUUID(),
  tomo: randomUUID(),
  k1: randomUUID(),
  k3: randomUUID(),
  z1: randomUUID(),
  z3: randomUUID(),
  domainA: randomUUID(),
};
const people = ["vesna", "petra", "ana", "dora", "eva", "tomo"] as const;
type Person = (typeof people)[number];
const token: Record<Person | "closed", string> = Object.fromEntries(
  [...people, "closed"].map((name) => [name, randomBytes(32).toString("base64url")]),
) as never;
// Random key bytes: the registry keeps every key unique, across runs too.
const spkiOf = () => `MCowBQYDK2VwAyEA${randomBytes(32).toString("base64url")}`;
const RECEIPT_KEY = spkiOf();
const CHECKPOINT_KEY = spkiOf();

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;

const institutionOf = (name: Person) => (name === "petra" || name === "tomo" ? id.b : id.a);

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2), ($3, $4)", [
    id.a,
    `it-eo-a-${suffix}`,
    id.b,
    `it-eo-b-${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Fakultet A (test)', 5, '15 minutes'), ($2, 'Fakultet B (test)', 5, '15 minutes')`,
    [id.a, id.b],
  );
  const accounts: [string, string, string][] = [
    [id.adminA, id.a, "adm-a"],
    [id.adminB, id.b, "adm-b"],
    ...people.map((name) => [id[name], institutionOf(name), name] as [string, string, string]),
  ];
  for (const [user, institution, name] of accounts) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
      [user, institution, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const name of people) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id[name], institutionOf(name)],
    );
  }
  await q(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at, closed_at, close_reason)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour', now(), 'logout')`,
    [token.closed, id.ana, id.a],
  );
  await q("SELECT institution.appoint_institution_admin($1, $2)", [
    id.adminA,
    `Zahtjev A ${suffix}`,
  ]);
  await q("SELECT institution.appoint_institution_admin($1, $2)", [
    id.adminB,
    `Zahtjev B ${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now()), ($4, $5, 'teacher', $6, now())`,
    [id.a, id.vesna, id.adminA, id.b, id.petra, id.adminB],
  );
  for (const [course, institution, teacher, students, assignment, acknowledged] of [
    [id.k1, id.a, id.vesna, [id.ana, id.dora, id.eva], id.z1, [id.ana, id.eva]],
    [id.k3, id.b, id.petra, [id.tomo], id.z3, [id.tomo]],
  ] as const) {
    await q(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
      [course, institution, teacher],
    );
    await q(
      `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'teacher' UNION ALL SELECT $1::uuid, $2::uuid, unnest($4::uuid[]), 'student'`,
      [course, institution, teacher, students],
    );
    await q(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
       VALUES ($1, $2, $3, 1, $4)`,
      [assignment, course, institution, teacher],
    );
    await q(
      `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
         opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
       VALUES ($1, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
         now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
      [assignment, teacher],
    );
    await q(
      `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
       SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
      [assignment, acknowledged, institution],
    );
  }
  // Institution A has an evidence domain with a receipt and a checkpoint key;
  // B has none, so a first start there is "not configured".
  await q(
    "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, $2, 'eu-central-1')",
    [id.domainA, id.a],
  );
  await q(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     VALUES ($1, '1', $3, $4, 'receipt', 'Ed25519', $5, date_trunc('minute', now()) - interval '1 day'),
            ($2, '1', $3, $4, 'checkpoint', 'Ed25519', $6, date_trunc('minute', now()) - interval '1 day')`,
    [
      `kljuc-potvrde-${suffix}`,
      `kljuc-kontrolne-${suffix}`,
      id.domainA,
      id.a,
      RECEIPT_KEY,
      CHECKPOINT_KEY,
    ],
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
  app = new pg.Pool({ connectionString: url.href, max: 4 });
  const withActor = createWithActor(app);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createEvidenceOpenRoute({
        actorReader: createActorReader(withActor),
        workOpener: createWorkOpener(withActor),
      }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

/** The JSON answer; the fields the tests read are named, the rest is checked against the contract. */
type Body = Record<string, unknown> & {
  document: string;
  documentHash: string;
  documentId: string;
};
type Answer = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Body;
};

function open(who: string, body: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path: "/api/v1/evidence/open",
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "ductus-protocol": "1",
          cookie: `__Host-ductus_session=${who}`,
          "content-length": String(Buffer.byteLength(text)),
          ...extra,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

const projects = async (person: string) =>
  Number(
    (
      await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM evidence.project WHERE principal_id = $1",
        [person],
      )
    ).rows[0]!.n,
  );

describe("evidence/open over real PostgreSQL with RLS", () => {
  it("B8: without start, a work that does not exist is 409 not_started and nothing is written", async () => {
    const answer = await open(token.ana, { assignmentId: id.z1 });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ status: "not_started" });
    expect(await projects(id.ana)).toBe(0);
    const withFalse = await open(token.ana, { assignmentId: id.z1, start: false });
    expect(withFalse.body).toEqual({ status: "not_started" });
    expect(await projects(id.ana)).toBe(0);
  });

  it("C1, D1, D2, D4: start makes the work once; the answer is the contract's, with receipt keys only", async () => {
    const first = await open(token.ana, { assignmentId: id.z1.toUpperCase(), start: true });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["set-cookie"]).toBeUndefined();
    expect(Value.Check(OPENED_SCHEMA, first.body)).toBe(true);
    const snapshot = Buffer.from(first.body.document, "base64");
    expect(createHash("sha256").update(snapshot).digest("hex")).toBe(first.body.documentHash);
    expect(first.body).toMatchObject({
      status: "opened",
      evidenceProfileId: "standard-v1",
      currentRevision: 0,
      headSegmentHash: null,
      lastSequenceTo: 0,
      submitted: false,
      // SRV-7F: the version of a work is that of its revision 0; SRV-33B: a new
      // work is v2, and at revision 0 the server's record of revision 0 is the
      // document the work opens with.
      schemaVersion: 2,
      revisionZeroHash: first.body.documentHash,
    });
    expect(first.body.receiptKeys).toEqual([
      expect.objectContaining({
        keyId: `kljuc-potvrde-${suffix}`,
        purpose: "receipt",
        evidenceDomainId: id.domainA,
        keyBase64Url: RECEIPT_KEY,
        validTo: null,
        revokedAt: null,
      }),
    ]);
    // Package and institution never leave the server.
    expect(JSON.stringify(first.body)).not.toContain(id.a);
    const again = await open(token.ana, { assignmentId: id.z1 });
    expect(again.body).toEqual(first.body);
    expect(await projects(id.ana)).toBe(1);
  });

  it("C2: two parallel first starts make one work and answer the same document", async () => {
    const [one, two] = await Promise.all([
      open(token.eva, { assignmentId: id.z1, start: true }),
      open(token.eva, { assignmentId: id.z1, start: true }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.documentId).toBe(two.body.documentId);
    expect(await projects(id.eva)).toBe(1);
  });

  it("C3, C4: another institution's, an unknown and the teacher's own assignment are the same 404", async () => {
    const answers = [
      await open(token.tomo, { assignmentId: id.z1, start: true }),
      await open(token.ana, { assignmentId: randomUUID(), start: true }),
      await open(token.ana, { assignmentId: id.z3, start: true }),
      await open(token.vesna, { assignmentId: id.z1, start: true }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ status: "not_found" });
    }
    expect(await projects(id.vesna)).toBe(0);
    expect(await projects(id.tomo)).toBe(0);
  });

  it("C5: a student who has not acknowledged the notice is 409 not_accepting", async () => {
    const answer = await open(token.dora, { assignmentId: id.z1, start: true });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ status: "not_accepting" });
    expect(await projects(id.dora)).toBe(0);
  });

  it("C6: a closed and an unknown session of the right form are 401 from the RPC", async () => {
    for (const who of [token.closed, randomBytes(32).toString("base64url")]) {
      const answer = await open(who, { assignmentId: id.z1, start: true });
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ status: "unauthenticated" });
    }
  });

  it("C7: a user id in a header never changes whose work is opened", async () => {
    const own = await open(token.ana, { assignmentId: id.z1 });
    const spoofed = await open(token.ana, { assignmentId: id.z1 }, { "x-user-id": id.eva });
    expect(spoofed.body.documentId).toBe(own.body.documentId);
  });

  it("C8: an institution without an evidence domain is 503 context with retry-after 5", async () => {
    const answer = await open(token.tomo, { assignmentId: id.z3, start: true });
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("5");
    expect(answer.body).toEqual({ status: "unavailable", stage: "context" });
  });
});
