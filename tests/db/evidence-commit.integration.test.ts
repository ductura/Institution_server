import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCommitContextReader,
  createWithActor,
  createWorkOpener,
  type WithActor,
} from "../../server/database/index.ts";

// DAN-815 part a1, plan of attack ductura/server#119 parts D9, D11 and F1: the
// commit context over real PostgreSQL with RLS, through a ductus_app login as
// in production. Every institution, person, course, token, key and text is
// random and synthetic; the login exists only while this file runs.
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
  k1: randomUUID(),
  z1: randomUUID(),
  domainA: randomUUID(),
};
const students = ["ana", "dora", "eva", "iva"] as const;
type Student = (typeof students)[number];
const token: Record<Student | "vesna" | "closed", string> = Object.fromEntries(
  [...students, "vesna", "closed"].map((name) => [name, randomBytes(32).toString("base64url")]),
) as never;

// Random key bytes: the registry keeps every key unique, across runs too.
const KEY_ID = `kljuc-potvrde-${suffix}`;
const RECEIPT_KEY = `MCowBQYDK2VwAyEA${randomBytes(32).toString("base64url")}`;

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
    [KEY_ID, id.domainA, id.a, RECEIPT_KEY],
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

type Work = { documentId: string; documentHash: string };
async function openWork(who: Student): Promise<Work> {
  const opened = await createWorkOpener(withActor).openWork(token[who], id.z1, true);
  if (opened.status !== "opened") throw new Error(`open: ${opened.status}`);
  return opened.work;
}

const readContext = (who: string, documentId: string, txid: string) =>
  createCommitContextReader(withActor).readContext(who, documentId, txid);

describe("evidence commit context over real PostgreSQL with RLS", () => {
  let ana: Work;
  beforeAll(async () => {
    ana = await openWork("ana");
  });

  it("names the package, domain, profile and chain of the caller's own work", async () => {
    const read = await readContext(token.ana, ana.documentId, `tx-${suffix}-1`);
    expect(read).toEqual({
      status: "ok",
      context: {
        evidencePackageId: expect.any(String),
        institutionId: id.a,
        evidenceDomainId: id.domainA,
        evidenceProfileId: "standard-v1",
        maxPayloadBytes: expect.any(Number),
        transactionKnown: false,
        state: {
          currentRevision: 0,
          documentHash: ana.documentHash,
          headSegmentHash: null,
          lastSequenceTo: 0,
        },
      },
    });
    const pkg = await admin.query<{ id: string; limit: number }>(
      "SELECT id, max_payload_bytes AS limit FROM evidence.package WHERE document_id = $1",
      [ana.documentId],
    );
    expect(read.status === "ok" && read.context.evidencePackageId).toBe(pkg.rows[0]?.id);
    expect(read.status === "ok" && read.context.maxPayloadBytes).toBe(pkg.rows[0]?.limit);
  });

  it("D9: another student's, an unknown and the teacher's document are the same not_found", async () => {
    for (const [who, documentId] of [
      [token.eva, ana.documentId],
      [token.ana, `nepostojeci-${suffix}`],
      [token.vesna, ana.documentId],
    ] as const) {
      expect(await readContext(who, documentId, `tx-${suffix}-x`)).toEqual({ status: "not_found" });
    }
  });

  it("D11: a closed or unknown session is unauthenticated", async () => {
    for (const who of [token.closed, randomBytes(32).toString("base64url")]) {
      expect(await readContext(who, ana.documentId, `tx-${suffix}-z`)).toEqual({
        status: "unauthenticated",
      });
    }
  });

  it("C5: an empty or control-character transaction id is invalid before any lookup", async () => {
    for (const txid of ["", "tx\n1", "tx\u00071"]) {
      expect(await readContext(token.ana, ana.documentId, txid)).toEqual({ status: "invalid" });
    }
    // PostgreSQL text holds no NUL: the driver fails, and the answer is a closed code.
    expect(await readContext(token.ana, ana.documentId, "tx\u0000")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_failed",
    });
  });
});
