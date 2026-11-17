import { randomBytes, randomUUID } from "node:crypto";

import { createSoftwareAuthenticator, type SoftwareAuthenticator } from "@ductura/test-fakes/fido2";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createOpenSession } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createWebAuthnRoutesFor,
  type Running,
  startServer,
} from "../../server/http/index.ts";
import { newSessionToken } from "../../server/session/index.ts";

// DAN-840-3f2 (contract Ductus#1836 c.6941883834): the whole WebAuthn flow on
// a real server with the real pipeline, mounted as server.ts mounts it, over
// the real main database: an operator with an AAI session (createOpenSession)
// registers a security key and confirms it; another session, another account's
// key, a replayed body, a clone, a revoked key and a closed session are
// refused with the contract's codes. Two confirmations with one counter are
// made to meet at use_webauthn_credential's UPDATE by a row lock the admin
// holds, so exactly one wins (#180). Every person, token, key and password is
// random and synthetic; the auth login lives only here.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const AUTH_LOGIN = "it_webauthn_route_auth";
const ORIGIN = "https://ductura.example.invalid";
const RP_ID = "ductura.example.invalid";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const homeOrg = `it-wa-${suffix}.ductus.test`;
const issuer = `https://issuer-wa-${suffix}.test`;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 3 });
const databases = createDatabases();
let auth: pg.Pool;
let server: Running;

let accounts = 0;
/** A fresh account and `count` of its sessions, opened as the AAI login opens them. */
async function signIn(count: number): Promise<string[]> {
  accounts += 1;
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { token, tokenHash } = newSessionToken();
    const opened = await createOpenSession(auth)({
      issuer,
      subject: `sub-wa-${accounts}`,
      uniqueId: `osoba${accounts}@${homeOrg}`,
      homeOrg,
      teacherEligible: false,
      tokenHash,
    });
    if (!opened.ok) throw new Error(`openSession refused: ${opened.reason}`);
    tokens.push(token);
  }
  return tokens;
}

async function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/auth/webauthn/${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "ductus-protocol": "1",
      cookie: `__Host-ductus_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}
const codeOf = async (answer: Response) => ((await answer.json()) as { code: string }).code;

async function challenge(token: string, purpose: "registration" | "assertion") {
  const answer = await post("challenge", token, { purpose });
  expect(answer.status).toBe(200);
  return (await answer.json()) as { challenge: string; allowCredentials?: string[] };
}
const bytes = (text: string) => Buffer.from(text, "base64url");
const wire = (b: Buffer) => b.toString("base64url");

async function register(token: string, device: SoftwareAuthenticator): Promise<Response> {
  const made = device.register(bytes((await challenge(token, "registration")).challenge));
  return post("registration", token, {
    clientDataJSON: wire(made.clientDataJSON),
    authenticatorData: wire(made.authenticatorData),
    credentialId: wire(made.credentialId),
  });
}
const assertionBody = (a: ReturnType<SoftwareAuthenticator["assert"]>) => ({
  clientDataJSON: wire(a.clientDataJSON),
  authenticatorData: wire(a.authenticatorData),
  credentialId: wire(a.credentialId),
  signature: wire(a.signature),
});
async function confirm(token: string, device: SoftwareAuthenticator): Promise<Response> {
  const issued = await challenge(token, "assertion");
  return post("assertion", token, assertionBody(device.assert(bytes(issued.challenge))));
}
const device = () => createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });

/** The stored rows of a credential id, read as the admin. */
const stored = async (id: Buffer) =>
  (
    await admin.query<{ key: Buffer; count: string; revoked: boolean }>(
      `SELECT public_key AS key, sign_count::text AS count, revoked_at IS NOT NULL AS revoked
         FROM identity.webauthn_credential WHERE credential_id = $1`,
      [id],
    )
  ).rows;

const SESSION = "WHERE token_hash = sha256(convert_to($1, 'UTF8'))";
/** Moves the session's start and last activity five minutes back, so a touch is visible. */
const age = (token: string) =>
  admin.query(
    `UPDATE identity.session SET created_at = now() - interval '5 minutes',
                                 last_seen_at = now() - interval '5 minutes' ${SESSION}`,
    [token],
  );
/** Waits (bounded) until the session's last activity is within the last minute. */
async function touched(token: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await admin.query<{ fresh: boolean }>(
      `SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM identity.session ${SESSION}`,
      [token],
    );
    if (rows[0]?.fresh) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the session's activity was never recorded");
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_auth', $1::text, $2::text) AS ddl",
    [AUTH_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  await admin.query(
    "INSERT INTO identity.institution (id, slug, aai_home_org) VALUES ($1, $2, $3)",
    [institution, `it-wa-${suffix}`, homeOrg],
  );
  await admin.query(
    "INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES ($1, $2)",
    [institution, issuer],
  );
  const url = new URL(ADMIN_URL);
  url.username = AUTH_LOGIN;
  url.password = password;
  auth = new pg.Pool({ connectionString: url.href, max: 2 });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases,
    routes: createWebAuthnRoutesFor(databases.main, ORIGIN),
  });
});

afterAll(async () => {
  await server?.close();
  await databases.close();
  await auth?.end();
  for (const table of [
    "webauthn_credential",
    "user_preference",
    "person_name",
    "teacher_eligibility",
    "session",
    "user_account",
  ]) {
    await admin.query(`DELETE FROM identity.${table} WHERE institution_id = $1`, [institution]);
  }
  await admin.query("DELETE FROM identity.institution_issuer WHERE institution_id = $1", [
    institution,
  ]);
  await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
  await admin.end();
  vi.restoreAllMocks();
});

describe("WebAuthn over real HTTP and PostgreSQL", () => {
  it("registers a key, lists it, confirms it, and records the session's activity each time", async () => {
    const [token = ""] = await signIn(1);
    const key = device();
    await age(token);
    expect((await register(token, key)).status).toBe(204);
    const [row] = await stored(key.credentialId);
    expect(row?.count).toBe("0");
    expect(row?.key.length).toBe(77);
    await touched(token);
    await age(token);
    const issued = await challenge(token, "assertion");
    expect(issued.allowCredentials).toEqual([wire(key.credentialId)]);
    const got = await post("assertion", token, assertionBody(key.assert(bytes(issued.challenge))));
    expect(got.status).toBe(204);
    expect((await stored(key.credentialId))[0]?.count).toBe("1");
    await touched(token);
  });

  it("refuses a second key (403) and a taken id on another account (409)", async () => {
    const [ana = ""] = await signIn(1);
    const [dora = ""] = await signIn(1);
    const key = device();
    expect((await register(ana, key)).status).toBe(204);
    const second = await register(ana, device());
    expect([second.status, await codeOf(second)]).toEqual([403, "forbidden"]);
    const taken = await register(dora, key);
    expect([taken.status, await codeOf(taken)]).toEqual([409, "conflict"]);
    expect(await stored(key.credentialId)).toHaveLength(1);
  });

  it("another session cannot use this session's challenge, nor confirm another account's key", async () => {
    const [ana = ""] = await signIn(1);
    const [dora = ""] = await signIn(1);
    const key = device();
    const made = key.register(bytes((await challenge(ana, "registration")).challenge));
    const foreign = await post("registration", dora, {
      clientDataJSON: wire(made.clientDataJSON),
      authenticatorData: wire(made.authenticatorData),
      credentialId: wire(made.credentialId),
    });
    expect([foreign.status, await codeOf(foreign)]).toEqual([400, "challenge_invalid"]);
    expect(await stored(key.credentialId)).toEqual([]);
    expect((await register(ana, key)).status).toBe(204);
    const notTheirs = await confirm(dora, key);
    expect([notTheirs.status, await codeOf(notTheirs)]).toEqual([403, "forbidden"]);
    expect((await stored(key.credentialId))[0]?.count).toBe("0");
  });

  it("a replayed body is refused even after a new challenge, which it spends", async () => {
    const [token = ""] = await signIn(1);
    const key = device();
    expect((await register(token, key)).status).toBe(204);
    const issued = await challenge(token, "assertion");
    const body = assertionBody(key.assert(bytes(issued.challenge)));
    expect((await post("assertion", token, body)).status).toBe(204);
    const fresh = await challenge(token, "assertion");
    const replayed = await post("assertion", token, body);
    expect([replayed.status, await codeOf(replayed)]).toEqual([400, "challenge_invalid"]);
    const late = await post("assertion", token, assertionBody(key.assert(bytes(fresh.challenge))));
    expect([late.status, await codeOf(late)]).toEqual([400, "challenge_invalid"]);
  });

  it("a clone behind is 409 and the stored counter stays", async () => {
    const [token = ""] = await signIn(1);
    const key = device();
    expect((await register(token, key)).status).toBe(204);
    const clone = key.clone();
    expect((await confirm(token, key)).status).toBe(204);
    const behind = await confirm(token, clone);
    expect([behind.status, await codeOf(behind)]).toEqual([409, "counter_not_increased"]);
    expect((await stored(key.credentialId))[0]?.count).toBe("1");
  });

  it("a revoked key leaves allowCredentials and is 403", async () => {
    const [token = ""] = await signIn(1);
    const key = device();
    expect((await register(token, key)).status).toBe(204);
    await admin.query(
      "UPDATE identity.webauthn_credential SET revoked_at = now() WHERE credential_id = $1",
      [key.credentialId],
    );
    expect((await challenge(token, "assertion")).allowCredentials).toEqual([]);
    const got = await confirm(token, key);
    expect([got.status, await codeOf(got)]).toEqual([403, "forbidden"]);
  });

  it("a session closed after its challenge: registration and assertion are 401", async () => {
    const [token = ""] = await signIn(1);
    const key = device();
    const made = key.register(bytes((await challenge(token, "registration")).challenge));
    const issued = await challenge(token, "assertion");
    await admin.query(
      `UPDATE identity.session SET closed_at = now(), close_reason = 'logout' ${SESSION}`,
      [token],
    );
    const registration = await post("registration", token, {
      clientDataJSON: wire(made.clientDataJSON),
      authenticatorData: wire(made.authenticatorData),
      credentialId: wire(made.credentialId),
    });
    expect([registration.status, await codeOf(registration)]).toEqual([401, "unauthorized"]);
    const assertion = await post(
      "assertion",
      token,
      assertionBody(key.assert(bytes(issued.challenge))),
    );
    expect([assertion.status, await codeOf(assertion)]).toEqual([401, "unauthorized"]);
    expect(await stored(key.credentialId)).toEqual([]);
  });

  it("two confirmations with one counter meet at the UPDATE: exactly one wins (#180)", async () => {
    const [one = "", two = ""] = await signIn(2);
    const key = device();
    expect((await register(one, key)).status).toBe(204);
    const clone = key.clone();
    const first = assertionBody(key.assert(bytes((await challenge(one, "assertion")).challenge)));
    const second = assertionBody(
      clone.assert(bytes((await challenge(two, "assertion")).challenge)),
    );
    const lock = await admin.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        "SELECT 1 FROM identity.webauthn_credential WHERE credential_id = $1 FOR UPDATE",
        [key.credentialId],
      );
      const answers = Promise.all([post("assertion", one, first), post("assertion", two, second)]);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 2; i += 1) {
        const { rows } = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_catalog.pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%use_webauthn_credential%'`,
        );
        waiting = Number(rows[0]?.n ?? 0);
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
      await lock.query("COMMIT");
      const got = await answers;
      expect(got.map((answer) => answer.status).sort()).toEqual([204, 409]);
    } finally {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
    expect((await stored(key.credentialId))[0]?.count).toBe("1");
  });
});
