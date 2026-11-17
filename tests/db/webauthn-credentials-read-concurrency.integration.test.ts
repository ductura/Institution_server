import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DAN-840-3a (contract on Ductus#1836): identity.webauthn_credentials_for_actor
// only reads, in one statement and without locks. While another connection of
// the same session holds an uncommitted use of the credential (the row lock of
// identity.use_webauthn_credential), a read must not wait: under a 2 s
// statement_timeout it returns the last committed counter, not 57014. After the
// use commits, a new statement sees the new counter. Every identifier, token
// and byte below is random and synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL = process.env.APP_DATABASE_URL ?? "";

const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const person = randomUUID();
const token = randomBytes(32).toString("base64url");

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const app = new pg.Pool({ connectionString: APP_URL, max: 2 });

/** Opens a READ COMMITTED transaction of the test session. */
async function begin(): Promise<pg.PoolClient> {
  const client = await app.connect();
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SELECT pg_catalog.set_config('app.session_token', $1, true)", [token]);
  return client;
}

/** The counters the session lists, as "hex:count", read under a 2 s statement timeout. */
async function read(client: pg.PoolClient): Promise<string[]> {
  await client.query("SET LOCAL statement_timeout = '2s'");
  const { rows } = await client.query<{ entry: string }>(
    "SELECT encode(credential_id, 'hex') || ':' || sign_count AS entry FROM identity.webauthn_credentials_for_actor()",
  );
  return rows.map((row) => row.entry);
}

beforeAll(async () => {
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    institution,
    `it-webauthn-read-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
     VALUES ($1, $2, $3, 'sub-engineer', 'engineer@it-webauthn-read.example')`,
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

describe("identity.webauthn_credentials_for_actor beside an uncommitted use", () => {
  it("does not wait on the use's row lock and sees the new counter only after commit", async () => {
    const id = randomBytes(16);
    const hex = id.toString("hex");
    await admin.query(
      `INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count)
       VALUES ($1, $2, $3, '\\x01', 4)`,
      [person, institution, id],
    );
    const a = await begin();
    const b = await begin();
    try {
      await a.query("SELECT identity.use_webauthn_credential($1, 5)", [id]);
      // The use wrote the row and holds it: its transaction id is locked and not committed.
      const pid = (await a.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const { rows } = await admin.query<{ held: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
                         WHERE pid = $1 AND locktype = 'transactionid' AND mode = 'ExclusiveLock' AND granted) AS held`,
        [pid],
      );
      expect(rows[0]?.held).toBe(true);
      expect(await read(b)).toEqual([`${hex}:4`]);
      await a.query("COMMIT");
      expect(await read(b)).toEqual([`${hex}:5`]);
      await b.query("COMMIT");
    } finally {
      // A failed step must not leave a transaction open in the pool (no-op after COMMIT).
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
  });
});
