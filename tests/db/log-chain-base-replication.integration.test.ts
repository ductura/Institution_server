// S-1K.8 (DAN-868-1a2) against the real logs database (CI: 127.0.0.1:54330,
// started with wal_level=logical): the apply of logical replication fires
// row triggers for INSERT, UPDATE and DELETE and the statement trigger only
// for TRUNCATE, so pgTAP cannot show that it leaves public.log_chain_base as
// it is. A source database of its own on the same cluster publishes tables
// of the same names, and a subscription of the superuser (run_as_owner, which
// RLS does not stop) applies each write to ductus_logs.
//
// The apply reports no SQLSTATE through SQL (pg_stat_subscription_stats only
// counts errors). So, besides the replicated UPDATE, DELETE and TRUNCATE the
// real base refuses, every write runs on a twin made for it: the base's
// definition with the base's own triggers in the same mode. The twin refuses
// the write, and with the trigger that should refuse it switched off the same
// write goes through, so that trigger is the cause. That both triggers of the
// base call one function, whose body only raises 55000, is pinned in
// db/logs/tests/020-log-chain.sql. INSERT is shown on an empty twin, as with
// one base row every INSERT would also break a constraint.
//
// The test never switches a trigger of the real base off. With no database,
// or wal_level below logical, it fails, it never skips. Every name it makes
// carries a suffix of this run; CREATE fails on a name that exists, and only
// what this run made is dropped.
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
const PROBE = `public.base_replication_probe_${RUN}`;
const BASE = "public.log_chain_base";
const ZERO = Buffer.alloc(32);
const COLUMNS = "(only_row boolean PRIMARY KEY, seq bigint NOT NULL, hash bytea NOT NULL)";
const ROW = "(true, 0, decode(repeat('00', 32), 'hex'))";
const ROW_TRIGGER = "log_chain_base_no_row_change";
const STATEMENT_TRIGGER = "log_chain_base_no_change";
const HOOK = 60_000;

/** A value in a libpq connection string: quoted, with \ and ' escaped by a backslash. */
const conninfo = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const logs = new pg.Client({ connectionString: LOGS_URL });
let source: pg.Client | undefined;
let publisher = "";
let databaseMade = false;
const tablesMade: string[] = [];
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
    `user=${conninfo(decodeURIComponent(url.username))}`,
    `password=${conninfo(decodeURIComponent(url.password))}`,
    `dbname=${SOURCE}`,
  ].join(" ");
  await logs.query(`CREATE DATABASE ${SOURCE}`);
  databaseMade = true;
  const sourceUrl = new URL(LOGS_URL);
  sourceUrl.pathname = `/${SOURCE}`;
  sourceUrl.search = "";
  source = new pg.Client({ connectionString: sourceUrl.toString() });
  await source.connect();
  await source.query(`
    CREATE TABLE ${BASE} ${COLUMNS};
    CREATE TABLE ${PROBE} (n int PRIMARY KEY);
    CREATE PUBLICATION base_replication FOR ALL TABLES`);
  await logs.query(`CREATE TABLE ${PROBE} (n int PRIMARY KEY)`);
  tablesMade.push(PROBE);
  const names = await logs.query<{ name: string }>(
    `SELECT tgname AS name FROM pg_trigger WHERE tgrelid = '${BASE}'::regclass AND NOT tgisinternal`,
  );
  expect(names.rows.map((t) => t.name).sort()).toStrictEqual([STATEMENT_TRIGGER, ROW_TRIGGER]);
}, HOOK);

afterAll(async () => {
  await source?.end();
  for (const table of tablesMade) await logs.query(`DROP TABLE ${table}`);
  if (databaseMade) await logs.query(`DROP DATABASE ${SOURCE}`);
  await logs.end();
}, HOOK);

const rows = async (table: string) =>
  (await logs.query<{ seq: string; hash: Buffer }>(`SELECT seq, hash FROM ${table}`)).rows;

/**
 * A twin of the base for one case, here and in the source: its columns,
 * constraints and, here, its triggers in the same mode; the base's row first
 * when `withRow`, written before the triggers exist.
 */
async function twin(withRow: boolean): Promise<string> {
  const name = `public.base_replication_twin_${RUN}_${String(++round)}`;
  await (source as pg.Client).query(`CREATE TABLE ${name} ${COLUMNS}`);
  await logs.query(`CREATE TABLE ${name} (LIKE ${BASE} INCLUDING ALL)`);
  tablesMade.push(name);
  if (withRow) await logs.query(`INSERT INTO ${name} VALUES ${ROW}`);
  const triggers = await logs.query<{ name: string; def: string; mode: string }>(
    `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS mode FROM pg_trigger
     WHERE tgrelid = '${BASE}'::regclass AND NOT tgisinternal`,
  );
  const enable = (mode: string) => (mode === "A" ? "ALWAYS" : mode === "R" ? "REPLICA" : "");
  for (const trigger of triggers.rows) {
    await logs.query(trigger.def.replace(` ON ${BASE} `, ` ON ${name} `));
    if (trigger.mode === "D")
      await logs.query(`ALTER TABLE ${name} DISABLE TRIGGER ${trigger.name}`);
    else
      await logs.query(
        `ALTER TABLE ${name} ENABLE ${enable(trigger.mode)} TRIGGER ${trigger.name}`,
      );
  }
  return name;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Sets the source's `table` as the subscriber has it, subscribes, replicates a
 * probe row and then `write`, and waits until the probe has arrived and either
 * the subscription stopped on an error (`refused`) or `applied` holds.
 */
async function replicate(
  table: string,
  withRow: boolean,
  write: string,
  outcome: "refused" | (() => Promise<boolean>),
) {
  const src = source as pg.Client;
  const name = `base_replication_${RUN}_${String(++round)}`;
  await src.query(`TRUNCATE ${table}`);
  if (withRow) await src.query(`INSERT INTO ${table} VALUES ${ROW}`);
  await src.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [name]);
  await logs.query(
    `CREATE SUBSCRIPTION ${name} CONNECTION ${logs.escapeLiteral(publisher)} PUBLICATION base_replication
     WITH (create_slot = false, slot_name = '${name}', copy_data = false, run_as_owner = true, disable_on_error = true)`,
  );
  try {
    await src.query(`INSERT INTO ${PROBE} VALUES ($1)`, [round]);
    await src.query(write.replaceAll("$TABLE", table));
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

const AS_MIGRATED = [{ seq: "0", hash: ZERO }];
const UPDATE = "UPDATE $TABLE SET seq = 5, hash = decode(repeat('ab', 32), 'hex')";
const CASES = [
  {
    op: "UPDATE",
    write: UPDATE,
    trigger: ROW_TRIGGER,
    withRow: true,
    changed: (r: { seq: string }[]) => r[0]?.seq === "5",
  },
  {
    op: "DELETE",
    write: "DELETE FROM $TABLE",
    trigger: ROW_TRIGGER,
    withRow: true,
    changed: (r: unknown[]) => r.length === 0,
  },
  {
    op: "TRUNCATE",
    write: "TRUNCATE $TABLE",
    trigger: STATEMENT_TRIGGER,
    withRow: true,
    changed: (r: unknown[]) => r.length === 0,
  },
  {
    op: "INSERT",
    write: `INSERT INTO $TABLE VALUES ${ROW}`,
    trigger: ROW_TRIGGER,
    withRow: false,
    changed: (r: unknown[]) => r.length === 1,
  },
];

describe("logical replication apply leaves the chain base as it is", () => {
  it.each(CASES.filter((c) => c.withRow))(
    "a replicated $op of the base is refused and the base stays",
    async ({ write }) => {
      await replicate(BASE, true, write, "refused");
      expect(await rows(BASE)).toStrictEqual(AS_MIGRATED);
    },
    60_000,
  );

  it.each(CASES)(
    "a replicated $op of a twin is refused, and goes through with $trigger off",
    async ({ write, trigger, withRow, changed }) => {
      const table = await twin(withRow);
      const before = await rows(table);
      await replicate(table, withRow, write, "refused");
      expect(await rows(table)).toStrictEqual(before);
      await logs.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await replicate(table, withRow, write, async () => changed(await rows(table)));
      expect(await rows(BASE)).toStrictEqual(AS_MIGRATED);
    },
    60_000,
  );
});
