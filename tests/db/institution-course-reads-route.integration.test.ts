import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createInstitutionCourseReadRoutesFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-1089 (contract Ductus#2028 c.6968016327): the two reads of A-03 on real
// PostgreSQL with RLS and a ductus_app login, through the real handler and the
// real port over institution.institution_academic_years() and
// institution.institution_courses(year). Only the administrator of the
// institution reads, and only their own institution; a teacher, a student and
// an unknown session read nothing. Every institution, person, name and token
// is random and invented; the login exists only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_institution_course_reads_app";
const ORIGIN = "https://ductura.example.invalid";
const YEAR = "2026/2027";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const inst = { a: randomUUID(), b: randomUUID() };
const user = {
  admin: randomUUID(),
  teacher: randomUUID(),
  student: randomUUID(),
  b1: randomUUID(),
};
type Who = keyof typeof user;
const homeOf = (who: Who) => (who === "b1" ? inst.b : inst.a);
const token = Object.fromEntries(
  Object.keys(user).map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<Who, string>;
const course = { a: randomUUID(), b: randomUUID() };
const group = randomUUID();

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
let app: pg.Pool;
let server: Running;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  for (const [name, id] of Object.entries(inst)) {
    await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      id,
      `it-reads-${name}-${suffix}`,
    ]);
  }
  for (const [name, id] of Object.entries(user) as [Who, string][]) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        homeOf(name),
        `https://issuer-${suffix}.test`,
        `sub-${name}`,
        `${name}@it-reads.example`,
      ],
    );
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id, homeOf(name)],
    );
  }
  for (const who of ["teacher", "b1"] as const) {
    await q(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
       VALUES ($1, $2, 'teacher', $2, now())`,
      [homeOf(who), user[who]],
    );
  }
  // An administrator only through the operator procedure (DAN-525), on an invented request.
  await q("SELECT institution.appoint_institution_admin($1, $2)", [user.admin, "Zahtjev T/2026"]);
  await q(
    "INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name) VALUES ($1, $2, 'Iva', 'Izmišljena')",
    [user.teacher, inst.a],
  );
  for (const [key, home, owner] of [
    ["a", inst.a, user.teacher],
    ["b", inst.b, user.b1],
  ] as const) {
    await q(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, $3, $4, 'encouraged', $5)`,
      [course[key], home, `Izmišljeni kolegij ${key}`, YEAR, owner],
    );
  }
  const a = [course.a, inst.a] as const;
  await q(
    "INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ($1, $2, $3, 'teacher'), ($1, $2, $4, 'student')",
    [...a, user.teacher, user.student],
  );
  await q(
    "INSERT INTO institution.course_holder (course_id, institution_id, user_id, assigned_by) VALUES ($1, $2, $3, $3)",
    [...a, user.teacher],
  );
  await q(
    "INSERT INTO institution.seminar_group (id, course_id, institution_id, name, created_by) VALUES ($1, $2, $3, 'Izmišljena grupa', $4)",
    [group, ...a, user.teacher],
  );
  for (const table of ["seminar_group_teacher", "seminar_group_member"]) {
    await q(
      `INSERT INTO institution.${table} (group_id, course_id, institution_id, user_id, assigned_by) VALUES ($1, $2, $3, $4, $5)`,
      [group, ...a, table === "seminar_group_teacher" ? user.teacher : user.student, user.teacher],
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
    routes: createInstitutionCourseReadRoutesFor({ withActor: createWithActor(app) }),
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
      "institution.seminar_group_member",
      "institution.seminar_group_teacher",
      "institution.seminar_group",
      "institution.course_holder",
      "institution.course_member",
      "institution.course",
      "institution.institution_role",
      "identity.person_name",
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
function get(path: string, cookie: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path,
        headers: { "sec-fetch-site": "same-origin", cookie: `__Host-ductus_session=${cookie}` },
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
    req.end();
  });
}
const YEARS = "/api/v1/institution/academic-years";
const list = (year: string) =>
  `/api/v1/institution/course-list?academicYear=${encodeURIComponent(year)}`;
const codeOf = (got: Answer) => [got.status, got.body.code];

describe("A-03 over real PostgreSQL: only the institution's administrator reads", () => {
  it("the administrator reads the years and the courses of their own institution only", async () => {
    expect(await get(YEARS, token.admin)).toEqual({ status: 200, body: { years: [YEAR] } });
    const iva = { personId: user.teacher, name: { givenName: "Iva", familyName: "Izmišljena" } };
    expect(await get(list(YEAR), token.admin)).toEqual({
      status: 200,
      body: {
        academicYear: YEAR,
        courses: [
          {
            ...{ courseId: course.a, name: "Izmišljeni kolegij a", students: 1, holder: iva },
            team: [iva],
            groups: [{ groupId: group, name: "Izmišljena grupa", students: 1, teachers: [iva] }],
          },
        ],
      },
    });
    expect(await get(list("2025/2026"), token.admin)).toEqual({
      status: 200,
      body: { academicYear: "2025/2026", courses: [] },
    });
  });

  it("a teacher and a student are 403 on both reads; an unknown session is 401", async () => {
    for (const who of ["teacher", "student", "b1"] as const) {
      expect(codeOf(await get(YEARS, token[who]))).toEqual([403, "forbidden"]);
      expect(codeOf(await get(list(YEAR), token[who]))).toEqual([403, "forbidden"]);
    }
    const unknown = randomBytes(32).toString("base64url");
    expect(codeOf(await get(YEARS, unknown))).toEqual([401, "unauthorized"]);
    expect(codeOf(await get(list(YEAR), unknown))).toEqual([401, "unauthorized"]);
  });
});
