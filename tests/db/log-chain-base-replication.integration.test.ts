// S-1K.8 (DAN-868-1a2) against the real logs database (CI: 127.0.0.1:54330,
// started with wal_level=logical): the apply of logical replication fires
// row triggers for INSERT, UPDATE and DELETE and the statement trigger only
// for TRUNCATE, so pgTAP cannot show that it leaves public.log_chain_base as
// it is. A source database of its own on the same cluster publishes tables
// of the same names, and a subscription of the superuser (run_as_owner, which
// RLS does not stop) applies each write to ductus_logs.
//
// The apply reports no SQLSTATE through SQL (pg_stat_subscription_stats only
// counts errors), so each refusal has a control: the same write with the
// trigger that should refuse it switched off goes through. The trigger is
// then switched on again (ALWAYS) and the base restored; afterAll does it
// once more. That the refusing body raises 55000 is pinned in
// db/logs/tests/020-log-chain.sql, with the body itself. INSERT is shown on an
// empty twin of the base's definition with the base's own triggers, as with
// one base row every INSERT would also break a constraint.
//
// With no database, or wal_level below logical, it fails, it never skips.
// Every name it makes carries a suffix of this run; CREATE fails on a name
// that exists, and only what this run made is dropped.
import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The chain base replication test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);
const RUN = randomBytes(6).toString("hex");
const SOURCE = `log_chain_base_source_${RUN}`;
const TWIN = `public.base_replication_twin_${RUN}`;
const PROBE = `public.base_replication_probe_${RUN}`;
const ZERO = Buffer.alloc(32);
const COLUMNS = "(only_row boolean PRIMARY KEY, seq bigint NOT NULL, hash bytea NOT NULL)";
const ROW = "(true, 0, decode(repeat('00', 32), 'hex'))";
const BASE = "public.log_chain_base";
const ROW_TRIGGER = "log_chain_base_no_row_change";
const STATEMENT_TRIGGER = "log_chain_base_no_change";
const HOOK = 60_000;

const logs = new pg.Client({ connectionString: LOGS_URL });
let source: pg.Client | undefined;
let publisher = "";
const made = { database: false, twin: false, probe: false, touched: false };
let round = 0;

beforeAll(async () => {
  await logs.connect();
  const level = (
    await logs.query<{ level: string }>("SELECT current_setting('wal_level') AS level")
  ).rows[0]?.level;
  if (level !== "logical")
    throw new Error(`the logs cluster needs wal_level=logical, not ${String(level)}`);
  // The apply worker runs inside the server: it reaches the source on the
  // port the server itself listens on (5432 in compose, 54330 in CI).
  const port = (await logs.query<{ port: number }>("SELECT inet_server_port() AS port")).rows[0]
    ?.port;
  const url = new URL(LOGS_URL);
  publisher = [
    "host=127.0.0.1",
    `port=${String(port)}`,
    `user=${logs.escapeLiteral(decodeURIComponent(url.username))}`,
    `password=${logs.escapeLiteral(decodeURIComponent(url.password))}`,
    `dbname=${SOURCE}`,
  ].join(" ");
  await logs.query(`CREATE DATABASE ${SOURCE}`);
  made.database = true;
  const sourceUrl = new URL(LOGS_URL);
  sourceUrl.pathname = `/${SOURCE}`;
  sourceUrl.search = "";
  source = new pg.Client({ connectionString: sourceUrl.toString() });
  await source.connect();
  await source.query(`
    CREATE TABLE ${BASE} ${COLUMNS};
    CREATE TABLE ${TWIN} ${COLUMNS};
    CREATE TABLE ${PROBE} (n int PRIMARY KEY);
    CREATE PUBLICATION base_replication FOR TABLE ${BASE}, ${TWIN}, ${PROBE}`);
  await logs.query(`CREATE TABLE ${PROBE} (n int PRIMARY KEY)`);
  made.probe = true;
  // The twin: the base's columns, constraints and triggers, in the same mode, with no row.
  await logs.query(`CREATE TABLE ${TWIN} (LIKE ${BASE} INCLUDING ALL)`);
  made.twin = true;
  const triggers = await logs.query<{ name: string; def: string; mode: string }>(
    `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS mode FROM pg_trigger
     WHERE tgrelid = '${BASE}'::regclass AND NOT tgisinternal`,
  );
  expect(triggers.rows.map((t) => t.name).sort()).toStrictEqual([STATEMENT_TRIGGER, ROW_TRIGGER]);
  const enable = (mode: string) => (mode === "A" ? "ALWAYS" : mode === "R" ? "REPLICA" : "");
  for (const { name, def, mode } of triggers.rows) {
    await logs.query(def.replace(` ON ${BASE} `, ` ON ${TWIN} `));
    if (mode === "D") await logs.query(`ALTER TABLE ${TWIN} DISABLE TRIGGER ${name}`);
    else await logs.query(`ALTER TABLE ${TWIN} ENABLE ${enable(mode)} TRIGGER ${name}`);
  }
}, HOOK);

afterAll(async () => {
  await source?.end();
  if (made.touched) await restore(BASE);
  if (made.twin) await logs.query(`DROP TABLE ${TWIN}`);
  if (made.probe) await logs.query(`DROP TABLE ${PROBE}`);
  if (made.database) await logs.query(`DROP DATABASE ${SOURCE}`);
  await logs.end();
}, HOOK);

const rows = async (table: string) =>
  (await logs.query<{ seq: string; hash: Buffer }>(`SELECT seq, hash FROM ${table}`)).rows;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Puts both triggers of `table` back to ALWAYS and its rows as migrated, in
 * one transaction that gives up on a lock after 5 s and rolls back on error.
 */
async function restore(table: string): Promise<void> {
  await logs.query("BEGIN");
  try {
    await logs.query("SET LOCAL lock_timeout = '5s'");
    await logs.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await logs.query(`DELETE FROM ${table}`);
    if (table === BASE) await logs.query(`INSERT INTO ${table} VALUES ${ROW}`);
    await logs.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${STATEMENT_TRIGGER}`);
    await logs.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${ROW_TRIGGER}`);
    await logs.query("COMMIT");
  } catch (error) {
    await logs.query("ROLLBACK");
    throw error;
  }
}

/**
 * Sets the source tables as the subscriber has them, subscribes, replicates a
 * probe row and then `write`, and waits until the probe has arrived and either
 * the subscription stopped on an error (`refused`) or `applied` holds.
 */
async function replicate(write: string, outcome: "refused" | (() => Promise<boolean>)) {
  const src = source as pg.Client;
  const name = `base_replication_${RUN}_${String(++round)}`;
  made.touched = true;
  await src.query(`TRUNCATE ${BASE}, ${TWIN}`);
  await src.query(`INSERT INTO ${BASE} VALUES ${ROW}`);
  await src.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [name]);
  await logs.query(
    `CREATE SUBSCRIPTION ${name} CONNECTION ${logs.escapeLiteral(publisher)} PUBLICATION base_replication
     WITH (create_slot = false, slot_name = '${name}', copy_data = false, run_as_owner = true, disable_on_error = true)`,
  );
  try {
    await src.query(`INSERT INTO ${PROBE} VALUES ($1)`, [round]);
    await src.query(write);
    const probed = async () =>
      (await logs.query(`SELECT 1 FROM ${PROBE} WHERE n = $1`, [round])).rowCount === 1;
    await until(
      outcome === "refused"
        ? async () =>
            (await probed()) &&
            (
              await logs.query(
                "SELECT 1 FROM pg_subscription WHERE subname = $1 AND NOT subenabled",
                [name],
              )
            ).rowCount === 1
        : async () => (await probed()) && (await outcome()),
      `${name}: ${outcome === "refused" ? "the apply stopped by an error" : "the write applied"}`,
    );
  } finally {
    await logs.query(`ALTER SUBSCRIPTION ${name} DISABLE`);
    await logs.query(`ALTER SUBSCRIPTION ${name} SET (slot_name = NONE)`);
    await logs.query(`DROP SUBSCRIPTION ${name}`);
    await src.query("SELECT pg_drop_replication_slot($1)", [name]);
  }
}

/** Runs `run` with `trigger` of `table` off, then puts the trigger back and the rows as they were. */
async function without(table: string, trigger: string, run: () => Promise<void>) {
  await logs.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await run();
  } finally {
    await restore(table);
  }
}

const AS_MIGRATED = [{ seq: "0", hash: ZERO }];
const CASES = [
  {
    op: "UPDATE",
    table: BASE,
    write: `UPDATE ${BASE} SET seq = 5, hash = decode(repeat('ab', 32), 'hex')`,
    trigger: ROW_TRIGGER,
    before: AS_MIGRATED,
    changed: async () => (await rows(BASE))[0]?.seq === "5",
  },
  {
    op: "DELETE",
    table: BASE,
    write: `DELETE FROM ${BASE}`,
    trigger: ROW_TRIGGER,
    before: AS_MIGRATED,
    changed: async () => (await rows(BASE)).length === 0,
  },
  {
    op: "TRUNCATE",
    table: BASE,
    write: `TRUNCATE ${BASE}`,
    trigger: STATEMENT_TRIGGER,
    before: AS_MIGRATED,
    changed: async () => (await rows(BASE)).length === 0,
  },
  {
    op: "INSERT",
    table: TWIN,
    write: `INSERT INTO ${TWIN} VALUES ${ROW}`,
    trigger: ROW_TRIGGER,
    before: [],
    changed: async () => (await rows(TWIN)).length === 1,
  },
];

describe("logical replication apply leaves the chain base as it is", () => {
  it.each(CASES)(
    "a replicated $op is refused and the rows stay",
    async ({ table, write, before }) => {
      await replicate(write, "refused");
      expect(await rows(table)).toStrictEqual(before);
    },
    60_000,
  );

  it.each(CASES)(
    "control: with $trigger off, the same replicated $op goes through",
    async ({ table, write, trigger, changed }) => {
      await without(table, trigger, () => replicate(write, changed));
      expect(await rows(BASE)).toStrictEqual(AS_MIGRATED);
    },
    60_000,
  );
});
