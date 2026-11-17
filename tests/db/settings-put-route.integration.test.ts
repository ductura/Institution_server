import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSettingsWriter,
  createWithActor,
  type SettingsWriter,
  type SettingWriteInput,
} from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createSettingsValuesPutRoute,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-826-2a (S-1J-g; contract Ductus#1836 c.6935304942): PUT
// /api/v1/settings/values over settings.set_value on real PostgreSQL with
// RLS and a ductus_app login. Another's level or course is 404 not_found, the
// same as one that does not exist (C-23), and the answer never carries the
// value of that level. The catalogue refuses every level but personal and
// network_security before the database (422), so the course, institution and
// system cases go through the adapter directly. Every institution, person,
// course and token is random and synthetic; the login exists only while this
// file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_settings_put_route_app";
const ORIGIN = "https://ductura.example.invalid";
const IDLE = "network.session_idle_minutes";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const inst = { a: randomUUID(), c: randomUUID() };
const user = {
  student: randomUUID(),
  teacherA: randomUUID(),
  teacherB: randomUUID(),
  revoked: randomUUID(),
  future: randomUUID(),
  closed: randomUUID(),
  teacherC: randomUUID(),
};
const course = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const token = Object.fromEntries(
  Object.keys(user).map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<keyof typeof user, string>;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
let app: pg.Pool;
let server: Running;
let writer: SettingsWriter;
/** The network_security row of IDLE this file made, or undefined when one was there already. */
let seededRow: string | undefined;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  for (const [id, institution] of [
    [inst.a, "a"],
    [inst.c, "c"],
  ] as const) {
    await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      id,
      `it-put-${institution}-${suffix}`,
    ]);
  }
  for (const [name, id] of Object.entries(user)) {
    const institution = name === "teacherC" ? inst.c : inst.a;
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, institution, `https://issuer-${suffix}.test`, `sub-${name}`, `${name}@it-put.example`],
    );
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name as keyof typeof user], id, institution],
    );
  }
  for (const [id, institution, teacher] of [
    [course.a, inst.a, user.teacherA],
    [course.b, inst.a, user.teacherB],
    [course.c, inst.c, user.teacherC],
  ] as const) {
    await q(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
      [id, institution, teacher],
    );
    // A teacher needs the confirmed role at the institution as well as the membership.
    await q(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
       VALUES ($1, $2, 'teacher', $2, now())`,
      [institution, teacher],
    );
    await q(
      `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
       VALUES ($1, $2, $3, 'teacher')`,
      [id, institution, teacher],
    );
  }
  // A revoked appointment and one that starts tomorrow: neither may write.
  await q(
    `INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by, appointed_at, revoked_at)
     VALUES ($1, $2, $2, now() - interval '2 days', now() - interval '1 day'),
            ($1, $3, $3, now() + interval '1 day', NULL)`,
    [inst.a, user.revoked, user.future],
  );
  // The higher level's value the answers must never carry. A row left by a
  // run that crashed is kept and read as it is.
  const made = await q(
    `INSERT INTO settings.value (level, key, value) VALUES ('network_security', $1, '77')
     ON CONFLICT DO NOTHING RETURNING id`,
    [IDLE],
  );
  seededRow = (made.rows[0] as { id: string } | undefined)?.id;
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
  writer = createSettingsWriter(createWithActor(app));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createSettingsValuesPutRoute({ writer })],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  // As the superuser: the history refuses DELETE to every other role.
  try {
    const ids = Object.values(user);
    if (seededRow !== undefined)
      await admin.query("DELETE FROM settings.value WHERE id = $1", [seededRow]);
    await admin.query("DELETE FROM settings.value WHERE institution_id = ANY ($1)", [
      Object.values(inst),
    ]);
    await admin.query("DELETE FROM settings.change WHERE changed_by = ANY ($1)", [ids]);
    await admin.query("DELETE FROM identity.session WHERE user_id = ANY ($1)", [ids]);
    await admin.query(
      "DELETE FROM identity.network_engineer_appointment WHERE institution_id = $1",
      [inst.a],
    );
    await admin.query("DELETE FROM institution.course_member WHERE course_id = ANY ($1)", [
      Object.values(course),
    ]);
    await admin.query("DELETE FROM institution.course WHERE id = ANY ($1)", [
      Object.values(course),
    ]);
    await admin.query("DELETE FROM institution.institution_role WHERE user_id = ANY ($1)", [ids]);
    await admin.query("DELETE FROM identity.user_account WHERE id = ANY ($1)", [ids]);
    await admin.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [
      Object.values(inst),
    ]);
  } finally {
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.end();
  }
});

type Answer = { status: number; text: string; body: Record<string, unknown> };
function put(who: string, body: Record<string, unknown>): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "PUT",
        path: "/api/v1/settings/values",
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          cookie: `__Host-ductus_session=${who}`,
        },
      },
      (res) => {
        let got = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (got += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: got, body: JSON.parse(got) as never }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

const body = (fields: Record<string, unknown> = {}) => ({
  level: "personal",
  course: null,
  key: "notifications.email",
  value: false,
  locked: false,
  min: null,
  max: null,
  ...fields,
});
const idle = (value: number) => body({ level: "network_security", key: IDLE, value });

/** What the tests may not change: the higher level's rows and the history. */
async function snapshot() {
  const rows = await admin.query(
    "SELECT id, level, value, bound, updated_at FROM settings.value WHERE key = $1 ORDER BY id",
    [IDLE],
  );
  const changes = await admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM settings.change",
  );
  return { rows: rows.rows, changes: changes.rows[0]!.n };
}

describe("PUT for another's level is 404 and never carries its value", () => {
  it.each([
    ["a student", "student"],
    ["a teacher", "teacherA"],
    ["a revoked appointment", "revoked"],
    ["an appointment that has not started", "future"],
  ] as const)("network_security by %s", async (_name, who) => {
    const before = await snapshot();
    const got = await put(token[who], idle(60));
    expect(got.status).toBe(404);
    expect(got.body).toEqual({
      error: "not_found",
      code: "not_found",
      messageKey: "errors.notFound",
      status: 404,
      requestId: expect.any(String),
    });
    // The request id is random and may hold any digits; the rest of the answer may not.
    expect(JSON.stringify({ ...got.body, requestId: "" })).not.toContain("77");
    expect(await snapshot()).toEqual(before);
  });

  it("the catalogue refuses a course level first (422), as the contract orders", async () => {
    const got = await put(token.teacherA, body({ level: "course", course: course.b }));
    expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
  });
});

describe("the adapter on the database: another's course or level is not_found", () => {
  const write = (fields: Partial<SettingWriteInput>): SettingWriteInput => ({
    level: "personal",
    course: null,
    key: "notifications.email",
    value: false,
    bound: null,
    ...fields,
  });

  it.each([
    ["a course of the same institution", "teacherA", { level: "course", course: course.b }],
    ["a course of another institution", "teacherA", { level: "course", course: course.c }],
    ["a course that does not exist", "teacherA", { level: "course", course: randomUUID() }],
    ["the institution level by a student", "student", { level: "institution" }],
    ["the system level by a teacher", "teacherA", { level: "system" }],
  ] as const)("%s", async (_name, who, fields) => {
    const before = await snapshot();
    expect(await writer.setValue(token[who], write(fields as Partial<SettingWriteInput>))).toEqual({
      status: "not_found",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("the teacher's own course is saved (the refusals above are not of the form)", async () => {
    const own = write({ level: "course", course: course.a });
    expect(await writer.setValue(token.teacherA, own)).toMatchObject({ status: "saved" });
  });
});

describe("other outcomes on the database", () => {
  it("a session closed after the cookie was issued is 401", async () => {
    await admin.query(
      "UPDATE identity.session SET closed_at = now(), close_reason = 'logout' WHERE user_id = $1",
      [user.closed],
    );
    const got = await put(token.closed, body());
    expect([got.status, got.body.code]).toEqual([401, "unauthorized"]);
  });

  it("a value under a higher lock is 409", async () => {
    const lock = await admin.query<{ id: string }>(
      `INSERT INTO settings.value (level, institution_id, key, bound)
       VALUES ('institution', $1, 'notifications.email', '{"locked": true}') RETURNING id`,
      [inst.a],
    );
    try {
      const got = await put(token.student, body({ value: true }));
      expect([got.status, got.body.code]).toEqual([409, "bound_crossed"]);
    } finally {
      await admin.query("DELETE FROM settings.value WHERE id = $1", [lock.rows[0]!.id]);
    }
  });

  it("the caller's own value is saved once, then unchanged", async () => {
    const first = await put(token.teacherB, body({ value: true }));
    expect([first.status, first.body]).toEqual([
      200,
      { key: "notifications.email", value: true, bound: null, changed: true },
    ]);
    const again = await put(token.teacherB, body({ value: true }));
    expect(again.body).toMatchObject({ changed: false });
    const history = await admin.query(
      "SELECT key, new_value FROM settings.change WHERE changed_by = $1",
      [user.teacherB],
    );
    expect(history.rows.map((row) => [row.key, row.new_value])).toEqual([
      ["notifications.email", true],
    ]);
  });
});
