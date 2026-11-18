// DAN-1056-1 (M1.3; contract Ductus#2028): the teacher right of DAN-304 on a
// teacher route, end to end over real PostgreSQL. Every account signs in the
// whole AAI-shaped way (real openid-client, the in-process provider of
// test-support/test-idp, never outside this process, D-09) into the real
// identity.open_session; an administrator confirms or revokes the teacher role
// through the RPCs with their own session; then POST /api/v1/institution/courses
// answers on a ductus_app login without BYPASSRLS. The account kind `teacher`
// (DAN-798) is the confirmed, unrevoked role in the account's institution; the
// right from hrEduPersonAffiliation only allows the confirmation. No role is
// written by hand. Every institution, account and name is random and synthetic.
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createOpenSession, createWithActor } from "../../server/database/index.ts";
import { createOidcClient, loadAuthConfig } from "../../server/external/srce-auth/index.ts";
import {
  createDatabases,
  createInstitutionCourseRoutesFor,
  createLayers,
  finishLogin,
  LOGIN_COOKIE_NAME,
  type Running,
  startLogin,
  startServer,
} from "../../server/http/index.ts";
import { SESSION_COOKIE_NAME } from "../../server/session/index.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../test-support/test-idp/index.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const ADMIN_URL = requireLoopbackDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
  "The teacher right test runs only against a loopback database (DATABASE_URL).",
);
const suffix = randomBytes(4).toString("hex");
const LOGINS = { auth: `it_teacher_right_auth_${suffix}`, app: `it_teacher_right_app_${suffix}` };
const password = randomBytes(24).toString("hex");
const ORIGIN = "https://ductura.example.invalid";
const CALLBACK = `${ORIGIN}/api/v1/auth/callback`;
const inst = {
  a: { id: randomUUID(), homeOrg: `tr-a-${suffix}.ductus.test` },
  b: { id: randomUUID(), homeOrg: `tr-b-${suffix}.ductus.test` },
};
const config = loadAuthConfig({
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "aai-eduhr",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: CALLBACK,
});

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
const pools: pg.Pool[] = [];
let server: Running;
let withActor: ReturnType<typeof createWithActor>;
let openSession: ReturnType<typeof createOpenSession>;

/** A pool logged in as a fresh login role that is a member of `role`. */
async function poolAs(login: string, role: string): Promise<pg.Pool> {
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE %I', $1::text, $2::text, $3::text) AS ddl",
    [login, password, role],
  );
  await admin.query(ddl.rows[0]!.ddl);
  const url = new URL(ADMIN_URL);
  url.username = login;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  pools.push(pool);
  return pool;
}

type Login = { readonly userId: string; readonly token: string };

/** One whole AAI-shaped login; the session token comes from the answer's cookie. */
async function signIn(
  name: string,
  home: keyof typeof inst,
  affiliation: string[],
): Promise<Login> {
  const idp = createTestIdp(
    {
      sub: `sub-${name}-${suffix}`,
      uniqueId: `${name}@${inst[home].homeOrg}`,
      homeOrg: inst[home].homeOrg,
      givenName: "Iva",
      familyName: "Izmišljena",
      affiliation,
    },
    ISSUER,
    "aai",
  );
  const deps = {
    config,
    oidc: createOidcClient(config, idp.fetch),
    openSession,
    closeSession: async () => true,
    closeAllSessions: async () => undefined,
  };
  const start = await startLogin(new Request(`${ORIGIN}/api/v1/auth/login`), deps);
  const attempt = start.headers.getSetCookie().find((c) => c.startsWith(`${LOGIN_COOKIE_NAME}=`))!;
  const done = await finishLogin(
    new Request(idp.approve(new URL(start.headers.get("location")!), CALLBACK), {
      headers: { cookie: attempt.slice(0, attempt.indexOf(";")) },
    }),
    deps,
  );
  expect(done.status, `${name} signed in`).toBe(303);
  const cookie = done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  const token = cookie!.slice(SESSION_COOKIE_NAME.length + 1, cookie!.indexOf(";"));
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM identity.user_account WHERE institution_id = $1 AND oidc_subject = $2",
    [inst[home].id, `sub-${name}-${suffix}`],
  );
  return { userId: rows[0]!.id, token };
}

/** An RPC on the role of `teacherId`, run with the administrator's session. */
const roleCall = (by: Login, fn: "confirm" | "revoke", teacherId: string) =>
  withActor(by.token, (tx) =>
    tx.query(`SELECT institution.${fn}_teacher_role($1) AS done`, [teacherId]),
  );

const who = {} as Record<
  "adminA" | "adminB" | "staff" | "student" | "candidate" | "revoked" | "lapsed" | "staffB",
  Login
>;

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [name, { id, homeOrg }] of Object.entries(inst)) {
    await admin.query(
      "INSERT INTO identity.institution (id, slug, aai_home_org) VALUES ($1, $2, $3)",
      [id, `it-tr-${name}-${suffix}`, homeOrg],
    );
    await admin.query(
      "INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES ($1, $2)",
      [id, ISSUER],
    );
  }
  openSession = createOpenSession(await poolAs(LOGINS.auth, "ductus_auth"));
  const app = await poolAs(LOGINS.app, "ductus_app");
  withActor = createWithActor(app);
  for (const [name, home] of [
    ["adminA", "a"],
    ["adminB", "b"],
  ] as const) {
    who[name] = await signIn(name, home, ["djelatnik"]);
    // An administrator only through the operator procedure (DAN-525), on an invented request.
    await admin.query("SELECT institution.appoint_institution_admin($1, $2)", [
      who[name].userId,
      "Zahtjev T/2026",
    ]);
  }
  for (const name of ["staff", "candidate", "revoked", "lapsed"] as const) {
    who[name] = await signIn(name, "a", ["djelatnik"]);
  }
  who.student = await signIn("student", "a", ["student"]);
  who.staffB = await signIn("staffB", "b", ["djelatnik"]);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInstitutionCourseRoutesFor({ withActor }),
  });
});

afterAll(async () => {
  await server?.close();
  for (const pool of pools) await pool.end();
  // The audit tables are append-only even for the superuser, so this file's
  // rows go with the triggers off, in one transaction.
  try {
    const ids = [inst.a.id, inst.b.id];
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "audit.teacher_role_event",
      "audit.institution_admin_event",
      "audit.course_member_event",
      "institution.course_member",
      "institution.course",
      "institution.institution_role",
      "identity.teacher_eligibility",
      "identity.person_name",
      "identity.session",
      "identity.user_account",
      "identity.institution_issuer",
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE institution_id = ANY ($1)`, [ids]);
    }
    await admin.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [ids]);
    await admin.query("COMMIT");
  } finally {
    for (const login of Object.values(LOGINS)) await admin.query(`DROP ROLE IF EXISTS ${login}`);
    await admin.end();
    vi.restoreAllMocks();
  }
});

/** POST /api/v1/institution/courses with `by`'s session; the status and the problem code. */
async function create(by: Login, name: string): Promise<[number, unknown]> {
  const answer = await fetch(`http://127.0.0.1:${server.port}/api/v1/institution/courses`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${by.token}`,
    },
    body: JSON.stringify({ name, academicYear: "2026/2027", aiPolicy: "encouraged" }),
  });
  const body = (await answer.json()) as Record<string, unknown>;
  return [answer.status, answer.status === 200 ? "ok" : body.code];
}
const courses = (name: string) =>
  admin.query<{ institution: string; creator: string }>(
    "SELECT institution_id AS institution, created_by AS creator FROM institution.course WHERE institution_id = ANY ($1) AND name = $2",
    [[inst.a.id, inst.b.id], name],
  );
const refused = { code: "ZD403" };
/** Whether the last login of `by` left the teacher right (identity.teacher_eligibility). */
const eligible = async (by: Login) =>
  (await admin.query("SELECT 1 FROM identity.teacher_eligibility WHERE user_id = $1", [by.userId]))
    .rowCount === 1;
/** Every teacher role row of `by` and every audit event on it, in order. */
async function trail(by: Login) {
  const roles = await admin.query<{ live: boolean }>(
    "SELECT confirmed_at IS NOT NULL AND revoked_at IS NULL AS live FROM institution.institution_role WHERE user_id = $1 AND role = 'teacher'",
    [by.userId],
  );
  const events = await admin.query<{ kind: string; actor: string }>(
    "SELECT kind, actor_id AS actor FROM audit.teacher_role_event WHERE teacher_id = $1 AND role = 'teacher' ORDER BY occurred_at, id",
    [by.userId],
  );
  return { roles: roles.rows.map((r) => r.live), events: events.rows };
}
/** A course name refused with 403 forbidden, and no course of that name anywhere. */
async function expectRefused(by: Login, name: string): Promise<void> {
  expect(await create(by, name)).toEqual([403, "forbidden"]);
  expect((await courses(name)).rows).toEqual([]);
}
const NONE = { roles: [], events: [] };

describe("DAN-1056-1: the teacher route only for a confirmed teacher of the account's institution", () => {
  it("N0 both administrators hold a live admin role of their own institution", async () => {
    const { rows } = await admin.query<{ institution: string }>(
      "SELECT institution_id AS institution FROM institution.institution_role WHERE user_id = ANY ($1) AND role = 'admin' AND confirmed_at IS NOT NULL AND revoked_at IS NULL ORDER BY user_id = $2 DESC",
      [[who.adminA.userId, who.adminB.userId], who.adminA.userId],
    );
    expect(rows.map((r) => r.institution)).toEqual([inst.a.id, inst.b.id]);
  });

  it("N1 a student login gives no right: the confirmation is refused and the route is 403", async () => {
    expect(await eligible(who.student)).toBe(false);
    await expect(roleCall(who.adminA, "confirm", who.student.userId)).rejects.toMatchObject(
      refused,
    );
    expect(await trail(who.student)).toEqual(NONE);
    await expectRefused(who.student, "Tečaj N1");
  });

  it("N1b the right is the last login's: a djelatnik who signs in as a student loses it", async () => {
    expect(await eligible(who.lapsed)).toBe(true);
    const again = await signIn("lapsed", "a", ["student"]);
    expect(again.userId).toBe(who.lapsed.userId);
    expect(await eligible(again)).toBe(false);
    await expect(roleCall(who.adminA, "confirm", again.userId)).rejects.toMatchObject(refused);
    expect(await trail(again)).toEqual(NONE);
    await expectRefused(again, "Tečaj N1b");
  });

  it("N2 the right alone, never confirmed, is 403, and no one but an administrator confirms", async () => {
    expect(await eligible(who.candidate)).toBe(true);
    await expect(roleCall(who.student, "confirm", who.candidate.userId)).rejects.toMatchObject(
      refused,
    );
    expect(await trail(who.candidate)).toEqual(NONE);
    await expectRefused(who.candidate, "Tečaj N2");
  });

  it("N3 belonging: only the account's own institution confirms it, and its course is there", async () => {
    // A role row always names the account's own institution (foreign key on
    // user_account), so the refusal by A leaves B's account with no role at all.
    expect(await eligible(who.staffB)).toBe(true);
    await expect(roleCall(who.adminA, "confirm", who.staffB.userId)).rejects.toMatchObject(refused);
    expect(await trail(who.staffB)).toEqual(NONE);
    await expectRefused(who.staffB, "Tečaj N3");
    await roleCall(who.adminB, "confirm", who.staffB.userId);
    expect(await create(who.staffB, "Tečaj N3 B")).toEqual([200, "ok"]);
    expect((await courses("Tečaj N3 B")).rows).toEqual([
      { institution: inst.b.id, creator: who.staffB.userId },
    ]);
  });

  it("N4 a confirmed teacher whose role was revoked is 403", async () => {
    await roleCall(who.adminA, "confirm", who.revoked.userId);
    expect(await create(who.revoked, "Tečaj N4 prije")).toEqual([200, "ok"]);
    const revoke = await roleCall(who.adminA, "revoke", who.revoked.userId);
    expect(revoke.rows).toEqual([{ done: true }]);
    expect(await trail(who.revoked)).toEqual({
      roles: [false],
      events: [
        { kind: "confirmed", actor: who.adminA.userId },
        { kind: "revoked", actor: who.adminA.userId },
      ],
    });
    await expectRefused(who.revoked, "Tečaj N4");
  });

  it("N5 an administrator with the right cannot confirm themselves, and is 403", async () => {
    expect(await eligible(who.adminA)).toBe(true);
    await expect(roleCall(who.adminA, "confirm", who.adminA.userId)).rejects.toMatchObject(refused);
    expect(await trail(who.adminA)).toEqual(NONE);
    await expectRefused(who.adminA, "Tečaj N5");
  });

  it("P1 the same djelatnik is 403 before the confirmation and 200 after, in its own institution", async () => {
    await expectRefused(who.staff, "Tečaj P1");
    await roleCall(who.adminA, "confirm", who.staff.userId);
    expect(await trail(who.staff)).toEqual({
      roles: [true],
      events: [{ kind: "confirmed", actor: who.adminA.userId }],
    });
    expect(await create(who.staff, "Tečaj P1")).toEqual([200, "ok"]);
    expect((await courses("Tečaj P1")).rows).toEqual([
      { institution: inst.a.id, creator: who.staff.userId },
    ]);
  });
});
