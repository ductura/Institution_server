import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createActorReader,
  createOpenSession,
  createWithActor,
} from "../../server/database/index.ts";
import { evidenceSession } from "../../server/http/index.ts";
import { newSessionToken } from "../../server/session/index.ts";

// DAN-805, plan of attack ductura/server#98 part B: the session step of the
// evidence routes over real PostgreSQL with RLS. Sessions are opened through
// openSession over a ductus_auth login and read back through withActor over a
// ductus_app login, as in production. Every identifier, token and password
// is random and synthetic; the logins exist only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const AUTH_LOGIN = "it_evidence_session_auth";
const APP_LOGIN = "it_evidence_session_app";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const homeOrg = `it-es-${suffix}.ductus.test`;
const issuer = `https://issuer-es-${suffix}.test`;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
const pools: pg.Pool[] = [];
function loginPool(login: string, max = 2): pg.Pool {
  const url = new URL(ADMIN_URL);
  url.username = login;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.href, max });
  pools.push(pool);
  return pool;
}

let opened = 0;
async function open(): Promise<string> {
  const { token, tokenHash } = newSessionToken();
  opened += 1;
  const result = await createOpenSession(auth)({
    issuer,
    subject: `sub-es-${opened}`,
    uniqueId: `osoba${opened}@${homeOrg}`,
    homeOrg,
    teacherEligible: false,
    tokenHash,
  });
  if (!result.ok) throw new Error(`openSession refused: ${result.reason}`);
  return token;
}

function request(token: string | undefined): IncomingMessage {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.cookie = `__Host-ductus_session=${token}`;
  return { headers } as unknown as IncomingMessage;
}

const sessionRow = (token: string) =>
  admin.query(
    `SELECT closed_at, close_reason, expires_at, last_seen_at FROM identity.session
      WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
    [token],
  );

let auth: pg.Pool;
let app: pg.Pool;
let check: (token: string | undefined) => ReturnType<typeof evidenceSession>;

beforeAll(async () => {
  for (const [login, group] of [
    [AUTH_LOGIN, "ductus_auth"],
    [APP_LOGIN, "ductus_app"],
  ]) {
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
    const ddl = await admin.query<{ ddl: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE %I', $1::text, $2::text, $3::text) AS ddl",
      [login, password, group],
    );
    await admin.query(ddl.rows[0]!.ddl);
  }
  await admin.query(
    "INSERT INTO identity.institution (id, slug, aai_home_org) VALUES ($1, $2, $3)",
    [institution, `it-es-${suffix}`, homeOrg],
  );
  await admin.query(
    "INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES ($1, $2)",
    [institution, issuer],
  );
  auth = loginPool(AUTH_LOGIN);
  app = loginPool(APP_LOGIN, 4);
  const actors = createActorReader(createWithActor(app));
  check = (token) => evidenceSession(request(token), actors, { live: true, maxBytes: 1024 });
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  for (const table of ["person_name", "teacher_eligibility"]) {
    await admin.query(`DELETE FROM identity.${table} WHERE institution_id = $1`, [institution]);
  }
  await admin.query("DELETE FROM identity.session WHERE institution_id = $1", [institution]);
  await admin.query("DELETE FROM identity.user_account WHERE institution_id = $1", [institution]);
  await admin.query("DELETE FROM identity.institution_issuer WHERE institution_id = $1", [
    institution,
  ]);
  await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

const UNAUTHENTICATED = expect.objectContaining({ ok: false, status: 401 });

describe("the evidence session step over real PostgreSQL", () => {
  it("B1: a session opened at sign-in passes, verified", async () => {
    const token = await open();
    expect(await check(token)).toEqual({ ok: true, token, verified: true });
  });

  it("B2: an unknown token of the right form is 401", async () => {
    expect(await check(newSessionToken().token)).toEqual(UNAUTHENTICATED);
    expect(await check(undefined)).toEqual(UNAUTHENTICATED);
  });

  it("B3, B5: a closed session is 401 whatever closed it", async () => {
    for (const reason of [
      "logout",
      "backchannel_logout",
      "logout_all",
      "institution_changed",
      "superseded",
    ]) {
      const token = await open();
      expect((await check(token)).ok).toBe(true);
      await admin.query(
        `UPDATE identity.session SET closed_at = now(), close_reason = $2
          WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
        [token, reason],
      );
      expect(await check(token)).toEqual(UNAUTHENTICATED);
    }
  });

  it("B4: an expired and an idle session are 401", async () => {
    const expired = await open();
    await admin.query(
      `UPDATE identity.session SET created_at = now() - interval '13 hours',
              last_seen_at = now() - interval '1 minute', expires_at = now() - interval '1 hour'
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [expired],
    );
    expect(await check(expired)).toEqual(UNAUTHENTICATED);
    const idle = await open();
    await admin.query(
      `UPDATE identity.session SET created_at = now() - interval '3 hours',
              last_seen_at = now() - interval '2 hours 1 minute'
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [idle],
    );
    expect(await check(idle)).toEqual(UNAUTHENTICATED);
  });

  it("B6: each token answers only for its own session", async () => {
    const first = await open();
    const second = await open();
    await admin.query(
      `UPDATE identity.session SET closed_at = now(), close_reason = 'logout'
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [first],
    );
    expect(await check(first)).toEqual(UNAUTHENTICATED);
    expect(await check(second)).toEqual({ ok: true, token: second, verified: true });
  });

  it("B12: the app login reads no session row directly", async () => {
    await open();
    await expect(app.query("SELECT count(*) FROM identity.session")).rejects.toThrow(
      /permission denied/u,
    );
  });

  it("B11: checks racing a sign-out each pass or answer 401, never 503", async () => {
    const token = await open();
    const checks = Array.from({ length: 12 }, () => check(token));
    await admin.query(
      `UPDATE identity.session SET closed_at = now(), close_reason = 'logout'
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [token],
    );
    for (const result of await Promise.all(checks)) {
      expect(result.ok || (!result.ok && result.status === 401)).toBe(true);
    }
    expect(await check(token)).toEqual(UNAUTHENTICATED);
  });

  it("D2: a check changes neither the session row nor its activity", async () => {
    const token = await open();
    const before = (await sessionRow(token)).rows;
    for (let i = 0; i < 3; i += 1) expect((await check(token)).ok).toBe(true);
    expect((await sessionRow(token)).rows).toEqual(before);
  });

  it("B7: a database that cannot be reached is 503 context, never 401", async () => {
    const token = await open();
    const url = new URL(ADMIN_URL);
    url.username = APP_LOGIN;
    url.password = password;
    url.port = "1";
    const dead = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 500 });
    pools.push(dead);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const actors = createActorReader(createWithActor(dead));
    const result = await evidenceSession(request(token), actors, { live: true, maxBytes: 1024 });
    vi.restoreAllMocks();
    expect(result).toEqual({
      ok: false,
      status: 503,
      body: { status: "unavailable", stage: "context" },
      headers: { "cache-control": "no-store", "retry-after": "5" },
    });
  });
});
