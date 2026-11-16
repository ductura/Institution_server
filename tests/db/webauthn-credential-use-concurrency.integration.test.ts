import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DAN-838-2a (contract on Ductus#1836): identity.use_webauthn_credential
// checks and writes the counter in one UPDATE, so two uses of one credential
// at the same time cannot both pass with the same counter. pgTAP runs in one
// connection; this test holds two app connections of one session open and
// fixes the order: the first use keeps its transaction open, the second must
// wait on the row lock (seen in pg_stat_activity), and only then does the
// first commit. No clock and no sleep decide the order. Every identifier,
// token and byte below is random and synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL = process.env.APP_DATABASE_URL ?? "";

const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const person = randomUUID();
const token = randomBytes(32).toString("base64url");

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const app = new pg.Pool({ connectionString: APP_URL, max: 2 });

const USE = "SELECT identity.use_webauthn_credential($1, $2)";

/** Opens a READ COMMITTED transaction of the test session. */
async function begin(): Promise<pg.PoolClient> {
  const client = await app.connect();
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
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

const pidOf = async (client: pg.PoolClient) =>
  (await client.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0]!.pid;

/** A new credential of the test person with counter 4; returns its id. */
async function credential(): Promise<Buffer> {
  const id = randomBytes(16);
  await admin.query(
    `INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count)
     VALUES ($1, $2, $3, '\\x01', 4)`,
    [person, institution, id],
  );
  return id;
}

const stored = async (id: Buffer) =>
  (
    await admin.query<{ count: string }>(
      "SELECT sign_count::text AS count FROM identity.webauthn_credential WHERE credential_id = $1",
      [id],
    )
  ).rows[0]?.count;

/** Uses `id` with `first` on one connection while the same use with `second` waits on the other. */
async function race(id: Buffer, first: number, second: number): Promise<string | undefined> {
  const a = await begin();
  const b = await begin();
  try {
    await a.query(USE, [id, first]);
    const pid = await pidOf(b);
    const late = b.query(USE, [id, second]).then(
      () => "ok",
      (error: { code?: string }) => error.code,
    );
    await waitUntilBlocked(pid);
    await a.query("COMMIT");
    const outcome = await late;
    await b.query(outcome === "ok" ? "COMMIT" : "ROLLBACK");
    return outcome;
  } finally {
    a.release();
    b.release();
  }
}

beforeAll(async () => {
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    institution,
    `it-webauthn-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
     VALUES ($1, $2, $3, 'sub-engineer', 'engineer@it-webauthn.example')`,
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

describe("identity.use_webauthn_credential under concurrent uses of one credential", () => {
  it("the same counter twice: the second waits, then is refused (ZD409)", async () => {
    const id = await credential();
    expect(await race(id, 5, 5)).toBe("ZD409");
    expect(await stored(id)).toBe("5");
  });

  it("a higher counter after the first: the second waits, then is accepted", async () => {
    const id = await credential();
    expect(await race(id, 5, 6)).toBe("ok");
    expect(await stored(id)).toBe("6");
  });
});
