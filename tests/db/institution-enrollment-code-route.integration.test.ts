import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createInstitutionCourseRoutesFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-852-5b2 (contract Ductus#1836 c.6952317823, K3): the enrolment code
// and its revocation on real PostgreSQL with RLS and a ductus_app login. The
// code leaves only to a teacher of the course; a course of another
// institution is 403 exactly as one that does not exist; the database keeps
// only the hash of the code. Every institution, person, course and token is
// random and synthetic; the login exists only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_enrollment_code_route_app";
const ORIGIN = "https://ductura.example.invalid";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const inst = { a: randomUUID(), b: randomUUID() };
const COURSE = randomUUID();
const user = {
  a1: randomUUID(),
  a2: randomUUID(),
  admin: randomUUID(),
  student: randomUUID(),
  revoked: randomUUID(),
  b1: randomUUID(),
};
type Who = keyof typeof user;
const homeOf = (who: Who) => (who === "b1" ? inst.b : inst.a);
const token = Object.fromEntries(
  Object.keys(user).map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<Who, string>;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
let app: pg.Pool;
let server: Running;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  for (const [name, id] of Object.entries(inst)) {
    await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      id,
      `it-code-${name}-${suffix}`,
    ]);
  }
  for (const [name, id] of Object.entries(user) as [Who, string][]) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, homeOf(name), `https://issuer-${suffix}.test`, `sub-${name}`, `${name}@it-code.example`],
    );
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id, homeOf(name)],
    );
  }
  for (const who of ["a1", "a2", "revoked", "b1"] as const) {
    await q(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at, revoked_at)
       VALUES ($1, $2, 'teacher', $2, now(), $3)`,
      [homeOf(who), user[who], who === "revoked" ? new Date() : null],
    );
  }
  // An administrator only through the operator procedure (DAN-525), on an invented request.
  await q("SELECT institution.appoint_institution_admin($1, $2)", [user.admin, "Zahtjev T/2026"]);
  // A1's course; the revoked teacher is still a member, so only the revoked role refuses them.
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Izmišljeni kolegij K3', '2026/2027', 'encouraged', $3)`,
    [COURSE, inst.a, user.a1],
  );
  for (const who of ["a1", "revoked"] as const) {
    await q(
      `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
       VALUES ($1, $2, $3, 'teacher')`,
      [COURSE, inst.a, user[who]],
    );
  }
}

beforeAll(async () => {
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  await seed();
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 2 });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInstitutionCourseRoutesFor({ withActor: createWithActor(app) }),
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  // The audit tables are append-only even for the superuser, so this file's
  // rows go with the triggers off, in one transaction.
  try {
    const insts = Object.values(inst);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "audit.teacher_role_event",
      "audit.institution_admin_event",
      "audit.course_member_event",
      "audit.enrollment_code_event",
      "institution.course_enrollment_code",
      "institution.course_member",
      "institution.course",
      "institution.institution_role",
      "identity.session",
      "identity.user_account",
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE institution_id = ANY ($1)`, [insts]);
    }
    await admin.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [insts]);
    await admin.query("COMMIT");
  } finally {
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.end();
  }
});

type Answer = { status: number; body: Record<string, unknown> };
function post(cookie: string, path: string, body: unknown): Promise<Answer> {
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
          "content-length": String(Buffer.byteLength(text)),
          cookie: `__Host-ductus_session=${cookie}`,
        },
      },
      (res) => {
        let got = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (got += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(got) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
const codePath = (id: string) => `/api/v1/institution/courses/${id}/enrollment-code`;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const issue = (who: Who, id = COURSE, validUntil = inDays(30)) =>
  post(token[who], codePath(id), { validUntil });
const revoke = (who: Who, id = COURSE) => post(token[who], `${codePath(id)}/revocation`, {});
const codes = () =>
  admin.query<{ id: string; hash: Buffer; active: boolean }>(
    "SELECT id, code_hash AS hash, active FROM institution.course_enrollment_code WHERE course_id = $1 ORDER BY created_at",
    [COURSE],
  );
const events = () =>
  admin.query<{ kind: string; code: string }>(
    "SELECT kind, code_id AS code FROM audit.enrollment_code_event WHERE course_id = $1 ORDER BY occurred_at",
    [COURSE],
  );
const withoutRequestId = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;
const CODE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/u;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest();

describe("K3: the enrolment code only to a teacher of the course, over real PostgreSQL", () => {
  it("a course of another institution is 403 exactly as one that does not exist", async () => {
    const answers = [
      await issue("b1"),
      await issue("b1", randomUUID()),
      await revoke("b1"),
      await revoke("b1", randomUUID()),
    ];
    expect(answers.map((got) => got.status)).toEqual([403, 403, 403, 403]);
    const bodies = answers.map((got) => withoutRequestId(got.body));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect((await codes()).rows).toEqual([]);
  });

  it("a teacher outside the course, an administrator, a student and a revoked member get no code", async () => {
    for (const who of ["a2", "admin", "student", "revoked"] as const) {
      const got = await issue(who);
      expect([who, got.status, got.body.code]).toEqual([who, 403, "forbidden"]);
    }
    expect((await codes()).rows).toEqual([]);
    expect((await events()).rows).toEqual([]);
  });

  it("an instant in the past or over a year ahead is 422 from the RPC, no row", async () => {
    for (const validUntil of [inDays(-1), inDays(400)]) {
      const got = await issue("a1", COURSE, validUntil);
      expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
    }
    expect((await codes()).rows).toEqual([]);
  });

  it("the teacher gets the code, the database keeps only its hash, a second replaces it", async () => {
    const first = await issue("a1");
    expect([first.status, Object.keys(first.body)]).toEqual([200, ["code"]]);
    const code = first.body.code as string;
    expect(code).toMatch(CODE);
    const plain = code.replaceAll("-", "");
    const [row] = (await codes()).rows;
    expect(row!.hash.equals(sha(plain))).toBe(true);
    const readable = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM institution.course_enrollment_code e WHERE e.course_id = $1 AND upper(e::text) LIKE $2",
      [COURSE, `%${plain}%`],
    );
    expect(readable.rows[0]).toEqual({ n: 0 });

    const second = await issue("a1");
    expect(second.status).toBe(200);
    expect(second.body.code).not.toBe(code);
    const after = (await codes()).rows;
    expect(after.map((r) => r.active)).toEqual([false, true]);
    expect((await events()).rows).toEqual([{ kind: "replaced", code: after[0]!.id }]);
  });

  it("revocation: a stranger changes nothing, the teacher revokes once, then false", async () => {
    expect((await revoke("b1")).status).toBe(403);
    expect((await codes()).rows.filter((r) => r.active)).toHaveLength(1);
    expect((await events()).rows).toHaveLength(1);
    const once = await revoke("a1");
    expect([once.status, once.body]).toEqual([200, { revoked: true }]);
    expect((await codes()).rows.filter((r) => r.active)).toEqual([]);
    expect((await events()).rows.map((e) => e.kind)).toEqual(["replaced", "revoked"]);
    const twice = await revoke("a1");
    expect([twice.status, twice.body]).toEqual([200, { revoked: false }]);
    expect((await events()).rows).toHaveLength(2);
  });
});
