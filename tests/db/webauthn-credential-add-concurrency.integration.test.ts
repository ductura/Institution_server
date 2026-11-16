import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DAN-838-2b (contract on Ductus#1836): identity.add_webauthn_credential locks
// the account row before it checks for a credential that is not revoked, so two
// first registrations of one account at the same time cannot both pass. pgTAP
// runs in one connection; this test holds two app connections of one session
// open: the first registration keeps its transaction open, the second (another
// id, so it cannot wait on the unique index) must wait on the account row, seen
// in pg_stat_activity, and only then does the first commit. No clock and no
// sleep decide the order. Every identifier, token and byte below is random and
// synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL = process.env.APP_DATABASE_URL ?? "";

const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const person = randomUUID();
const token = randomBytes(32).toString("base64url");

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const app = new pg.Pool({ connectionString: APP_URL, max: 2 });

const ADD = "SELECT identity.add_webauthn_credential($1, '\\x01', 0)";

/** Opens a transaction of the test session, READ COMMITTED unless `level` says otherwise. */
async function begin(level = "READ COMMITTED"): Promise<pg.PoolClient> {
  const client = await app.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${level}`);
  await client.query("SELECT pg_catalog.set_config('app.session_token', $1, true)", [token]);
  return client;
}

/** Waits until the backend `pid` is blocked on a lock; fails after 10 s. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await admin.query<{ waiting: boolean }>(
      "SELECT coalesce(wait_event_type = 'Lock', false) AS waiting FROM pg_catalog.pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

beforeAll(async () => {
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    institution,
    `it-webauthn-add-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
     VALUES ($1, $2, $3, 'sub-engineer', 'engineer@it-webauthn-add.example')`,
    [person, institution, `https://issuer-${suffix}.test`],
  );
  await admin.query(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
    [token, person, institution],
  );
});

afterAll(async () => {
  try {
    await admin.query("DELETE FROM identity.webauthn_credential WHERE institution_id = $1", [
      institution,
    ]);
    await admin.query("DELETE FROM identity.session WHERE institution_id = $1", [institution]);
    await admin.query("DELETE FROM identity.user_account WHERE institution_id = $1", [institution]);
    await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  } finally {
    await app.end();
    await admin.end();
  }
});

describe("identity.add_webauthn_credential under two first registrations of one account", () => {
  it("the second waits on the account, then is refused (ZD403); one row stays", async () => {
    const a = await begin();
    const b = await begin();
    try {
      await a.query(ADD, [randomBytes(16)]);
      const pid = (await b.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const late = b.query(ADD, [randomBytes(16)]).then(
        () => "ok",
        (error: { code?: string }) => error.code,
      );
      await waitUntilBlocked(pid);
      await a.query("COMMIT");
      expect(await late).toBe("ZD403");
      await b.query("ROLLBACK");
    } finally {
      // A failed wait leaves both transactions open; their locks would block afterAll.
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM identity.webauthn_credential WHERE user_id = $1",
      [person],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE"])(
    "a fixed snapshot (%s) is refused (25000), as the lock could not order it",
    async (level) => {
      const client = await begin(level);
      try {
        const outcome = await client.query(ADD, [randomBytes(16)]).then(
          () => "ok",
          (error: { code?: string }) => error.code,
        );
        expect(outcome).toBe("25000");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );
});
