// SRV-09 acceptance (Ductus#2028 c.7008147932) over real PostgreSQL with RLS
// and the local seed (db/main/local/seed.sql, SRV-01): demo-student reads
// "Moji zadaci" through the real route, a ductus_app login and
// institution.student_assignments() (SRV-08), and gets the seminar's
// assignment in the contract's shape; a new invented account with no course
// gets an empty list. The login exists only while this file runs.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedStatements } from "../../scripts/lokalno/index.ts";
import { ROUTES } from "../../server/contracts/index.ts";
import { createWithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createStudentAssignmentsRouteFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_student_assignments_app";
const ROOT = join(import.meta.dirname, "../..");
const SCHEMA = ROUTES.find((r) => r.id === "student.assignments.get")!.responses[0]!.body;
const password = randomBytes(24).toString("hex");
const tokens = {
  student: randomBytes(32).toString("base64url"),
  nobody: randomBytes(32).toString("base64url"),
};
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;

/** A live session of the demo-fakultet account `subject`, made first when `create`. */
async function session(token: string, subject: string, create = false): Promise<void> {
  if (create) {
    await admin.query(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       SELECT gen_random_uuid(), i.id, 'http://localhost:8090', $1, $1 || '@demo.ductus.test'
         FROM identity.institution i WHERE i.slug = 'demo-fakultet'`,
      [subject],
    );
  }
  await admin.query(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     SELECT sha256(convert_to($1, 'UTF8')), u.id, u.institution_id, now() + interval '1 hour'
       FROM identity.user_account u JOIN identity.institution i ON i.id = u.institution_id
      WHERE i.slug = 'demo-fakultet' AND u.oidc_subject = $2`,
    [token, subject],
  );
}

beforeAll(async () => {
  await admin.query(seedStatements(readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8")));
  await session(tokens.student, "demo-student");
  await session(tokens.nobody, `srv09-${randomUUID()}`, true);
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
    routes: [createStudentAssignmentsRouteFor({ withActor: createWithActor(app) })],
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
        path: "/api/v1/student/assignments",
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

describe("SRV-09: the student's assignments from the seed", () => {
  it("demo-student sees the seminar's assignment, its notice acknowledged", async () => {
    const got = await get(tokens.student);
    expect(got.status).toBe(200);
    expect(Value.Check(SCHEMA as never, got.body)).toBe(true);
    const courses = got.body.courses as Record<string, unknown>[];
    expect(courses).toContainEqual({
      id: expect.any(String),
      name: "Izmišljeni seminar iz ekologije grada",
      academicYear: "2026/2027",
      assignments: [
        {
          id: expect.any(String),
          title: "Seminarski rad: kućno kompostiranje",
          dueAt: "2027-01-31T22:59:00.000Z",
          noticeFirst: false,
          workType: "seminar_paper",
          extendedDueAt: null,
        },
      ],
    });
  });

  it("an account with no course gets an empty list", async () => {
    expect(await get(tokens.nobody)).toEqual({ status: 200, body: { courses: [] } });
  });
});
