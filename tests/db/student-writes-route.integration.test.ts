// SRV-10 acceptance (Ductus#2028 c.7008147932) over real PostgreSQL with RLS
// and the local seed (db/main/local/seed.sql, SRV-01): a new invented student
// of demo-fakultet enrols with the seed's codes through the real routes and a
// ductus_app login, then marks the seminar's notice as read. Each run makes
// its own student, so a rerun meets neither an earlier enrolment nor earlier
// attempts. Every person and code is invented; the login exists only while
// this file runs.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedStatements } from "../../scripts/lokalno/index.ts";
import { createWithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createStudentWriteRoutesFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_student_writes_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const password = randomBytes(24).toString("hex");
const tokens = {
  student: randomBytes(32).toString("base64url"),
  stranger: randomBytes(32).toString("base64url"),
};
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;
let assignment: { id: string; version: number };

/** A new invented account of demo-fakultet with a live session behind `token`. */
async function student(token: string): Promise<void> {
  const subject = `srv10-${randomUUID()}`;
  await admin.query(
    `WITH i AS (SELECT id FROM identity.institution WHERE slug = 'demo-fakultet'),
          u AS (INSERT INTO identity.user_account
                  (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
                SELECT gen_random_uuid(), i.id, 'http://localhost:8090', $2, $2 || '@demo.ductus.test'
                  FROM i RETURNING id, institution_id)
     INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     SELECT sha256(convert_to($1, 'UTF8')), u.id, u.institution_id, now() + interval '1 hour' FROM u`,
    [token, subject],
  );
}

beforeAll(async () => {
  await admin.query(seedStatements(readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8")));
  const { rows } = await admin.query<{ id: string; version: number }>(
    `SELECT a.id, a.current_version AS version FROM institution.assignment a
       JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
       JOIN identity.institution i ON i.id = a.institution_id AND i.slug = 'demo-fakultet'
      WHERE v.title = 'Seminarski rad: kućno kompostiranje'`,
  );
  expect(rows).toHaveLength(1);
  assignment = rows[0]!;
  await student(tokens.student);
  await student(tokens.stranger);
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 2 });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createStudentWriteRoutesFor({ withActor: createWithActor(app) }),
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

function post(path: string, body: unknown, token: string) {
  const text = JSON.stringify(body);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
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
          cookie: `__Host-ductus_session=${token}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
const enrol = (code: string, token = tokens.student) =>
  post("/api/v1/student/enrollments", { code }, token);
const readNotice = (versionNo: number, token = tokens.student) =>
  post(`/api/v1/student/assignments/${assignment.id}/notice-read`, { versionNo }, token);

describe("SRV-10: enrolment with the seed's codes and the notice read", () => {
  it("UPIS2026DEMO enrols, a second time is already_enrolled, in any spelling", async () => {
    const first = await enrol("UPIS2026DEMO");
    expect(first).toMatchObject({ status: 200, body: { outcome: "enrolled" } });
    const again = await enrol("upis-2026 demo");
    expect(again).toEqual({ status: 200, body: { ...first.body, outcome: "already_enrolled" } });
  });

  // For one who is not a member: a member entering an old code of their own
  // course is told already_enrolled (20261119120000).
  it("STARI2025KOD is expired_code, an unknown code invalid_code", async () => {
    expect(await enrol("STARI2025KOD", tokens.stranger)).toMatchObject({
      status: 422,
      body: { code: "expired_code" },
    });
    expect(await enrol("NEPOSTOJECI0001", tokens.stranger)).toMatchObject({
      status: 422,
      body: { code: "invalid_code" },
    });
  });

  it("PRAZNI2026DEMO enrols in the course without an assignment", async () => {
    expect(await enrol("PRAZNI2026DEMO")).toMatchObject({
      status: 200,
      body: { outcome: "enrolled_no_assignment" },
    });
  });

  it("the notice of the current version is read once; another version and a stranger record nothing", async () => {
    expect(await readNotice(assignment.version + 1)).toMatchObject({
      status: 409,
      body: { code: "conflict" },
    });
    const read = await readNotice(assignment.version);
    expect(read.status).toBe(200);
    expect(Date.parse(String(read.body.readAt))).not.toBeNaN();
    expect(await readNotice(assignment.version)).toEqual(read);
    expect((await readNotice(assignment.version, tokens.stranger)).status).toBe(404);
  });
});
