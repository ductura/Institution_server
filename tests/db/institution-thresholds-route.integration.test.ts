import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSettingsWriter,
  createWithActor,
  type WithActor,
} from "../../server/database/index.ts";
import { defaultOf } from "../../server/domain/index.ts";
import {
  createDatabases,
  createLayers,
  createSettingsValuesPutRoute,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-1060-1 (Ductus#2028, contract c.6965951277): an institution threshold
// is changed only by an administrator of that institution, over PUT
// /api/v1/settings/values on real PostgreSQL with RLS and a ductus_app login,
// and is read through the settings levels (settings.read_values). Negative
// cases first; after each, institution A's row and the history of the key
// are as they were. The institution comes only from the session, so the
// administrator of institution C can change only C. Every institution,
// person, course and token is random and synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_institution_thresholds_app";
const ORIGIN = "https://ductura.example.invalid";
const KEY = "thresholds.session_gap_minutes";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const inst = { a: randomUUID(), c: randomUUID() };
const user = {
  adminA: randomUUID(),
  revokedA: randomUUID(),
  student: randomUUID(),
  teacher: randomUUID(),
  closed: randomUUID(),
  adminC: randomUUID(),
};
const courseA = randomUUID();
const token = Object.fromEntries(
  Object.keys(user).map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<keyof typeof user, string>;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
let app: pg.Pool;
let withActor: WithActor;
let server: Running;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  for (const [id, name] of [
    [inst.a, "a"],
    [inst.c, "c"],
  ] as const)
    await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      id,
      `it-thr-${name}-${suffix}`,
    ]);
  for (const [name, id] of Object.entries(user)) {
    const institution = name === "adminC" ? inst.c : inst.a;
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, institution, `https://issuer-${suffix}.test`, `sub-${name}`, `${name}@it-thr.example`],
    );
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[name as keyof typeof user], id, institution],
    );
  }
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [courseA, inst.a, user.teacher],
  );
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $2, now())`,
    [inst.a, user.teacher],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     VALUES ($1, $2, $3, 'teacher'), ($1, $2, $4, 'student')`,
    [courseA, inst.a, user.teacher, user.student],
  );
  // Administrators only through the operator procedure, on invented requests.
  for (const id of [user.adminA, user.revokedA, user.adminC])
    await q("SELECT institution.appoint_institution_admin($1, $2)", [id, "Zahtjev T/2026"]);
  await q("SELECT institution.revoke_institution_admin($1, $2)", [
    user.revokedA,
    "Zahtjev T/2026-2",
  ]);
  await q(
    "UPDATE identity.session SET closed_at = now(), close_reason = 'logout' WHERE user_id = $1",
    [user.closed],
  );
  // A's value before the tests, so "unchanged" is not "absent".
  await q(
    "INSERT INTO settings.value (level, institution_id, key, value) VALUES ('institution', $1, $2, '45')",
    [inst.a, KEY],
  );
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
  withActor = createWithActor(app);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createSettingsValuesPutRoute({ writer: createSettingsWriter(withActor) })],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  // The history and the audit tables are append-only even for the superuser,
  // so this file's rows go with the triggers off, in one transaction.
  try {
    const insts = Object.values(inst);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("DELETE FROM settings.change WHERE institution_id = ANY ($1)", [insts]);
    for (const table of [
      "settings.value",
      "audit.teacher_role_event",
      "audit.institution_admin_event",
      "audit.course_member_event",
      "institution.course_member",
      "institution.course",
      "institution.institution_role",
      "identity.session",
      "identity.user_account",
    ])
      await admin.query(`DELETE FROM ${table} WHERE institution_id = ANY ($1)`, [insts]);
    await admin.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [insts]);
    await admin.query("COMMIT");
  } finally {
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.end();
  }
});

type Answer = { status: number; body: Record<string, unknown> };
function put(cookie: string | null, fields: Record<string, unknown> = {}): Promise<Answer> {
  const text = JSON.stringify({
    level: "institution",
    course: null,
    key: KEY,
    value: 60,
    locked: false,
    min: null,
    max: null,
    ...fields,
  });
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
          ...(cookie === null ? {} : { cookie: `__Host-ductus_session=${cookie}` }),
        },
      },
      (res) => {
        let got = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (got += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(got) as never }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

/** Institution A's row of the key and the history of the key in both institutions. */
async function stateOfA() {
  const row = await admin.query(
    "SELECT id, value, bound, updated_at FROM settings.value WHERE level = 'institution' AND institution_id = $1 AND key = $2",
    [inst.a, KEY],
  );
  const changes = await admin.query(
    "SELECT institution_id AS institution, new_value AS value, changed_by AS author FROM settings.change WHERE key = $1 AND institution_id = ANY ($2) ORDER BY id",
    [KEY, Object.values(inst)],
  );
  return { row: row.rows, changes: changes.rows };
}

/** The institution level as its administrator reads it, through the settings levels. */
const readLevel = (who: string) =>
  withActor(who, async (tx) => {
    const rows = await tx.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM settings.read_values('institution', NULL) WHERE key = $1",
      [KEY],
    );
    return rows.rows;
  });

describe("nobody but an administrator of the institution changes its threshold", () => {
  it.each([
    ["an anonymous caller", null, 401, "unauthorized"],
    ["a session that does not exist", randomBytes(32).toString("base64url"), 401, "unauthorized"],
    ["a closed session", "closed", 401, "unauthorized"],
    ["a student of A", "student", 404, "not_found"],
    ["a teacher of A", "teacher", 404, "not_found"],
    ["a revoked administrator of A", "revokedA", 404, "not_found"],
  ] as const)("%s is refused and A is unchanged", async (_name, who, status, code) => {
    const before = await stateOfA();
    const cookie = who !== null && who in token ? token[who as keyof typeof token] : who;
    const got = await put(cookie);
    expect([got.status, got.body.code]).toEqual([status, code]);
    expect(await stateOfA()).toEqual(before);
  });

  it.each([
    ["the personal level", { level: "personal" }],
    ["the system level", { level: "system" }],
    ["the course level", { level: "course", course: courseA }],
    ["a value above the limit", { value: 241 }],
    ["a negative value", { value: -1 }],
    ["a decimal value", { value: 1.5 }],
    ["a string value", { value: "30" }],
    ["a boolean value", { value: true }],
    ["a named institution", { institution: inst.a }],
  ])("the administrator of A with %s is 422 and A is unchanged", async (_name, fields) => {
    const before = await stateOfA();
    const got = await put(token.adminA, fields);
    expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
    expect(await stateOfA()).toEqual(before);
  });

  it("the administrator of C changes only C, never A", async () => {
    const before = await stateOfA();
    const got = await put(token.adminC, { value: 90 });
    expect([got.status, got.body]).toEqual([
      200,
      { key: KEY, value: 90, bound: null, changed: true },
    ]);
    const after = await stateOfA();
    expect(after.row).toEqual(before.row);
    expect(after.changes.slice(before.changes.length)).toEqual([
      { institution: inst.c, value: 90, author: user.adminC },
    ]);
    expect(await readLevel(token.adminA)).toEqual([{ key: KEY, value: 45 }]);
    expect(await readLevel(token.adminC)).toEqual([{ key: KEY, value: 90 }]);
  });
});

describe("the administrator of A", () => {
  it("changes the threshold once, with history, and reads it through the levels", async () => {
    const before = await stateOfA();
    const got = await put(token.adminA, { value: 60 });
    expect([got.status, got.body]).toEqual([
      200,
      { key: KEY, value: 60, bound: null, changed: true },
    ]);
    expect(await readLevel(token.adminA)).toEqual([{ key: KEY, value: 60 }]);
    const after = await stateOfA();
    expect(after.changes.slice(before.changes.length)).toEqual([
      { institution: inst.a, value: 60, author: user.adminA },
    ]);
    const again = await put(token.adminA, { value: 60 });
    expect([again.status, again.body.changed]).toEqual([200, false]);
    expect((await stateOfA()).changes).toEqual(after.changes);
  });

  it("removes the value, and the catalogue default holds again", async () => {
    const got = await put(token.adminA, { value: null });
    expect([got.status, got.body]).toEqual([
      200,
      { key: KEY, value: null, bound: null, changed: true },
    ]);
    expect(await readLevel(token.adminA)).toEqual([]);
    expect(defaultOf(KEY)).toBe(30);
  });
});
