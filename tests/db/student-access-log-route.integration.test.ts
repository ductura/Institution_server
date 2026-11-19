// SRV-11 acceptance (Ductus#2028 c.7008147932) over real PostgreSQL with RLS:
// on the local seed (db/main/local/seed.sql, SRV-01), demo-student reads the
// access log of their own work and sees the one row the seed writes,
// demo-teacher opening it on the fast path; demo-student-2 reads the same work
// as 404 (C-23). The route is the real one with a ductus_app login. Every
// person and text is invented; the login exists only while this file runs.
import { randomBytes } from "node:crypto";
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
  createStudentAccessLogRouteFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_student_access_log_app";
const ROOT = join(import.meta.dirname, "../..");
const password = randomBytes(24).toString("hex");
const tokens = {
  student: randomBytes(32).toString("base64url"),
  other: randomBytes(32).toString("base64url"),
};
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;
let documentId: string;

beforeAll(async () => {
  await admin.query(seedStatements(readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8")));
  const { rows } = await admin.query<{ document: string }>(
    `SELECT l.document_id AS document FROM audit.access_log l
       JOIN identity.user_account r ON r.id = l.reader_id AND r.oidc_subject = 'demo-teacher'
       JOIN identity.institution i ON i.id = r.institution_id AND i.slug = 'demo-fakultet'`,
  );
  expect(rows).toHaveLength(1);
  documentId = rows[0]!.document;
  for (const [subject, token] of [
    ["demo-student", tokens.student],
    ["demo-student-2", tokens.other],
  ]) {
    await admin.query(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       SELECT sha256(convert_to($1, 'UTF8')), u.id, u.institution_id, now() + interval '1 hour'
         FROM identity.user_account u JOIN identity.institution i ON i.id = u.institution_id
        WHERE i.slug = 'demo-fakultet' AND u.oidc_subject = $2`,
      [token, subject],
    );
  }
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
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createStudentAccessLogRouteFor({ withActor: createWithActor(app) })],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

function get(token: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: `/api/v1/student/works/${encodeURIComponent(documentId)}/access-log`,
        headers: { cookie: `__Host-ductus_session=${token}`, "sec-fetch-site": "same-origin" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("SRV-11: the access log of the seeded work", () => {
  it("demo-student sees demo-teacher's opening from the seed", async () => {
    const got = await get(tokens.student);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ next: null, continued: false });
    expect(got.body.entries).toEqual([
      expect.objectContaining({
        role: "teacher",
        surface: "fast_path",
        reader: { givenName: "Petar", familyName: "Kranjčec" },
      }),
    ]);
  });

  it("demo-student-2 reads the same work as 404", async () => {
    expect((await get(tokens.other)).status).toBe(404);
  });
});
