import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DAN-801 (S-1J-e): settings.set_value orders every write of one key with a
// transaction-level advisory lock, so a higher bound and a lower value written
// at the same time never miss each other under READ COMMITTED. pgTAP runs in
// one connection; this test holds two app connections open at once and fixes
// the order: the first call keeps its transaction open, the second must wait
// on the lock (seen in pg_stat_activity), and only then does the first commit.
// Without the lock the second call would not wait, and the lower value would
// stay above the bound. Every identifier and token below is random and
// synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL = process.env.APP_DATABASE_URL ?? "";

const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const engineer = randomUUID();
const student = randomUUID();
const engineerToken = randomBytes(32).toString("base64url");
const studentToken = randomBytes(32).toString("base64url");

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const app = new pg.Pool({ connectionString: APP_URL, max: 2 });
const keys: string[] = [];

const SET = "SELECT settings.set_value($1, NULL, $2, $3::jsonb, $4::jsonb) AS id";

/** Opens a READ COMMITTED transaction as the person of `token`. */
async function begin(token: string): Promise<pg.PoolClient> {
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

beforeAll(async () => {
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    institution,
    `it-set-${suffix}`,
  ]);
  for (const [id, name] of [
    [engineer, "engineer"],
    [student, "student"],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, institution, `https://issuer-${suffix}.test`, `sub-${name}`, `${name}@it-set.example`],
    );
  }
  // The higher level is network_security: its writer needs only an
  // appointment row, which the cleanup can delete again. An institution
  // administrator is appointed through the operator procedure, whose audit
  // rows are append-only and would stay behind. Both levels go through the
  // same lock and the same two checks of set_value.
  await admin.query(
    `INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by, appointed_at)
     VALUES ($1, $2, $2, now() - interval '1 minute')`,
    [institution, engineer],
  );
  await admin.query(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $4, now() + interval '1 hour'),
            (sha256(convert_to($3, 'UTF8')), $5, $4, now() + interval '1 hour')`,
    [engineerToken, engineer, studentToken, institution, student],
  );
});

afterAll(async () => {
  // As the superuser: the history refuses DELETE to every other role.
  try {
    await admin.query("DELETE FROM settings.value WHERE key = ANY ($1)", [keys]);
    await admin.query("DELETE FROM settings.change WHERE key = ANY ($1)", [keys]);
    await admin.query("DELETE FROM identity.session WHERE institution_id = $1", [institution]);
    await admin.query(
      "DELETE FROM identity.network_engineer_appointment WHERE institution_id = $1",
      [institution],
    );
    await admin.query("DELETE FROM identity.user_account WHERE institution_id = $1", [institution]);
    await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  } finally {
    await app.end();
    await admin.end();
  }
});

describe("settings.set_value under concurrent writes of one key", () => {
  it("a lower value written while a bound is open waits, then is refused (ZD409)", async () => {
    const key = `network.race_bound_first_${suffix}`;
    keys.push(key);
    const first = await begin(engineerToken);
    const second = await begin(studentToken);
    try {
      await first.query(SET, ["network_security", key, null, '{"max": 4}']);
      const pid = await pidOf(second);
      const lower = second.query(SET, ["personal", key, "9", null]).then(
        () => "ok",
        (error: { code?: string }) => error.code,
      );
      await waitUntilBlocked(pid);
      await first.query("COMMIT");
      expect(await lower).toBe("ZD409");
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }
    const { rows } = await admin.query<{ level: string; value: unknown; bound: unknown }>(
      "SELECT level, value, bound FROM settings.value WHERE key = $1",
      [key],
    );
    expect(rows).toEqual([{ level: "network_security", value: null, bound: { max: 4 } }]);
  });

  it("a bound written while a lower value is open waits, then deletes it with a history row", async () => {
    const key = `network.race_value_first_${suffix}`;
    keys.push(key);
    const first = await begin(studentToken);
    const second = await begin(engineerToken);
    try {
      await first.query(SET, ["personal", key, "9", null]);
      const pid = await pidOf(second);
      const bound = second.query(SET, ["network_security", key, null, '{"max": 4}']);
      await waitUntilBlocked(pid);
      await first.query("COMMIT");
      await bound;
      await second.query("COMMIT");
    } finally {
      first.release();
      second.release();
    }
    const stored = await admin.query<{ level: string }>(
      "SELECT level FROM settings.value WHERE key = $1",
      [key],
    );
    expect(stored.rows).toEqual([{ level: "network_security" }]);
    const history = await admin.query(
      `SELECT level, cause, old_value AS "oldValue", new_value AS "newValue", changed_by AS "changedBy" FROM settings.change
       WHERE key = $1 ORDER BY id`,
      [key],
    );
    expect(history.rows).toEqual([
      { level: "personal", cause: "set", oldValue: null, newValue: 9, changedBy: student },
      {
        level: "network_security",
        cause: "set",
        oldValue: null,
        newValue: null,
        changedBy: engineer,
      },
      { level: "personal", cause: "bound", oldValue: 9, newValue: null, changedBy: engineer },
    ]);
  });
});
