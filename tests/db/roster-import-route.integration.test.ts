import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWithActor } from "../../server/database/index.ts";
import {
  createAdminActionLogRouteFor,
  createDatabases,
  createLayers,
  createRosterImportRoutesFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// INT-29 (NF-7 OA-10, SRV-ADMIN-2 #671 and SRV-ADMIN-2B #679): the roster
// import end to end over real PostgreSQL with RLS and a ductus_app login, as
// the live check on `pnpm lokalno` ran it (Ductus#2055). An administrator
// previews a file (nobody enrolled), confirms it (exactly the new rows
// enrolled), confirms again (same answer, nobody twice) and previews the same
// file again (nobody new). Another institution's administrator, a teacher and
// a student get nothing; an expired preview is 410; the database log records
// the confirmation once, and the HTTP log still answers. Every institution,
// person and token is random and synthetic; the login exists only while this
// file runs. The CSV format is the contract's proposal, not a real export.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_roster_import_route_app";
const ORIGIN = "https://ductura.example.invalid";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const inst = { a: randomUUID(), b: randomUUID() };
const COURSE = randomUUID();
const user = {
  admin: randomUUID(),
  teacher: randomUUID(),
  enrolled: randomUUID(),
  fresh: randomUUID(),
  adminB: randomUUID(),
  studentB: randomUUID(),
};
type Who = keyof typeof user;
const homeOf = (who: Who) => (who === "adminB" || who === "studentB" ? inst.b : inst.a);
const idOf = (who: Who) => `${who.toLowerCase()}-${suffix}@it-roster.example`;
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
      `it-roster-${name}-${suffix}`,
    ]);
  }
  for (const [name, id] of Object.entries(user) as [Who, string][]) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, homeOf(name), `https://issuer-${suffix}.test`, `sub-${name}`, idOf(name)],
    );
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name], id, homeOf(name)],
    );
  }
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $2, now())`,
    [inst.a, user.teacher],
  );
  // Administrators only through the operator procedure (DAN-525), on invented requests.
  await q("SELECT institution.appoint_institution_admin($1, $2)", [user.admin, "Zahtjev R/2026"]);
  await q("SELECT institution.appoint_institution_admin($1, $2)", [user.adminB, "Zahtjev R/2027"]);
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Izmišljeni kolegij za uvoz popisa', '2026/2027', 'encouraged', $3)`,
    [COURSE, inst.a, user.teacher],
  );
  for (const [who, role] of [
    ["teacher", "teacher"],
    ["enrolled", "student"],
  ] as const) {
    await q(
      `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [COURSE, inst.a, user[who], role],
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
  const main = { withActor: createWithActor(app) };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [...createRosterImportRoutesFor(main), createAdminActionLogRouteFor(main)],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  // The audit tables and the roster import are append-only even for the
  // superuser (ZD409), so this file's rows go with the triggers off, in one
  // transaction, children first.
  try {
    const insts = Object.values(inst);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "institution.roster_import_entry",
      "institution.roster_import",
      "audit.teacher_role_event",
      "audit.institution_admin_event",
      "audit.course_member_event",
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
function call(
  cookie: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Answer> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path,
        headers: {
          ...(method === "POST"
            ? {
                origin: ORIGIN,
                "sec-fetch-site": "same-origin",
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(text)),
              }
            : {}),
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
const previewPath = (course = COURSE) =>
  `/api/v1/institution/admin/courses/${course}/roster-imports`;
const confirmPath = (id: string) => `/api/v1/institution/admin/roster-imports/${id}/confirm`;
const preview = (who: Who, csv: string, course = COURSE) =>
  call(token[who], "POST", previewPath(course), { source: "merlin", csv });
const confirm = (who: Who, id: string) => call(token[who], "POST", confirmPath(id), {});
const csv = (rows: readonly string[]) =>
  ["identifikator;ime;prezime", ...rows].join("\r\n") + "\r\n";
// A file as an export might carry it: case and space around the identifier,
// a row twice, a teacher of the course, a student of another institution, an
// unknown account and an identifier without a domain.
const FILE = csv([
  `${idOf("fresh")};Ana;Izmišljena`,
  ` ${idOf("enrolled").toUpperCase()} ;Iva;Izmišljena`,
  `${idOf("fresh")};Ana;Izmišljena`,
  `${idOf("teacher")};Ivo;Izmišljeni`,
  `${idOf("studentB")};Eva;Izmišljena`,
  `nitko-${suffix}@it-roster.example;Nina;Izmišljena`,
  "bez-domene;Ena;Izmišljena",
]);
const students = async () =>
  (
    await admin.query<{ user_id: string }>(
      "SELECT user_id FROM institution.course_member WHERE course_id = $1 AND role = 'student' ORDER BY user_id",
      [COURSE],
    )
  ).rows.map((row) => row.user_id);
const dbLog = () =>
  createWithActor(app)(token.admin, (tx) =>
    tx.query<{ action: string }>(
      "SELECT action FROM app.admin_action_log() WHERE action = 'roster_import_confirmed'",
    ),
  );

describe("INT-29: roster import end to end over real PostgreSQL", () => {
  let importId = "";

  it("a preview sorts every row and enrolls nobody", async () => {
    const before = await students();
    const got = await preview("admin", FILE);
    expect(got.status).toBe(200);
    expect(got.body.counts).toEqual({ new: 1, alreadyEnrolled: 1, unsuitable: 5 });
    const rows = got.body.rows as { line: number; status: string; reason: string | null }[];
    expect(rows.map((row) => [row.line, row.status, row.reason])).toEqual([
      [2, "new", null],
      [3, "already_enrolled", null],
      [4, "unsuitable", "duplicate"],
      [5, "unsuitable", "course_teacher"],
      [6, "unsuitable", "unknown_account"],
      [7, "unsuitable", "unknown_account"],
      [8, "unsuitable", "invalid_identifier"],
    ]);
    expect(await students()).toEqual(before);
    importId = got.body.importId as string;
  });

  it("nobody but an administrator of the course's institution previews or confirms", async () => {
    for (const who of ["teacher", "enrolled"] as const) {
      expect((await preview(who, FILE)).status).toBe(403);
      expect((await confirm(who, importId)).status).toBe(403);
    }
    expect((await preview("adminB", FILE)).status).toBe(404);
    expect((await confirm("adminB", importId)).status).toBe(404);
  });

  it("a confirmation enrolls exactly the new row, and a repeat changes nothing", async () => {
    const first = await confirm("admin", importId);
    expect(first).toMatchObject({
      status: 200,
      body: { enrolled: 1, alreadyEnrolled: 0, skipped: 0, alreadyConfirmed: false },
    });
    expect(await students()).toEqual([user.enrolled, user.fresh].sort());
    const again = await confirm("admin", importId);
    expect(again).toMatchObject({
      status: 200,
      body: { enrolled: 1, alreadyEnrolled: 0, skipped: 0, alreadyConfirmed: true },
    });
    expect(await students()).toEqual([user.enrolled, user.fresh].sort());
  });

  it("the same file again has nobody new, and its confirmation enrolls nobody", async () => {
    const second = await preview("admin", FILE);
    expect(second.body.counts).toEqual({ new: 0, alreadyEnrolled: 2, unsuitable: 5 });
    const done = await confirm("admin", second.body.importId as string);
    expect(done).toMatchObject({ status: 200, body: { enrolled: 0, alreadyConfirmed: false } });
    expect(await students()).toEqual([user.enrolled, user.fresh].sort());
  });

  it("an expired preview is 410 and enrolls nobody", async () => {
    const late = await preview("admin", csv([`${idOf("studentB")};Eva;Izmišljena`]));
    expect(late.status).toBe(200);
    // Only the test moves the clock: the table refuses any change but a confirmation.
    // The window keeps its 30 minutes (expires_at > created_at), only earlier.
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE institution.roster_import
            SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute'
          WHERE id = $1`,
        [late.body.importId],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    const got = await confirm("admin", late.body.importId as string);
    expect([got.status, got.body.code]).toEqual([410, "import_expired"]);
  });

  it("the database log holds each confirmed import once; the HTTP log still answers", async () => {
    // Two confirmed imports (the first confirmed twice), the expired one never.
    expect((await dbLog()).rows).toHaveLength(2);
    const log = await call(token.admin, "GET", "/api/v1/institution/admin-actions");
    expect(log.status).toBe(200);
    // SRV-ADMIN-2B: the reader leaves the new kind out until the owner decides
    // how it is published, and nothing in the log names a person.
    const text = JSON.stringify(log.body);
    expect(text).not.toContain("roster_import_confirmed");
    expect(text).not.toContain("it-roster.example");
    expect((await call(token.teacher, "GET", "/api/v1/institution/admin-actions")).status).toBe(
      403,
    );
  });
});
