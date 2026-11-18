// S-1K.8 (DAN-868-1a) against the real logs database (CI: 127.0.0.1:54330,
// started with wal_level=logical): the apply of logical replication fires
// row triggers for INSERT, UPDATE and DELETE and the statement trigger only
// for TRUNCATE, so pgTAP cannot show that it leaves public.log_chain_base as
// it is. Here a source database on the same cluster publishes a table of the
// same name, and a subscription of the superuser (run_as_owner, which RLS
// does not stop) applies each write to ductus_logs. The apply must fail and
// the base stay seq 0 and 32 zero bytes; a probe row replicated just before
// shows the apply did run. With no database, or wal_level below logical, it
// fails, it never skips. Everything it makes is dropped again.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The chain base replication test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);
const SOURCE = "log_chain_base_replication_source";
const sourceUrl = (): string => {
  const url = new URL(LOGS_URL);
  url.pathname = `/${SOURCE}`;
  url.search = "";
  return url.toString();
};
const ZERO = Buffer.alloc(32);

const logs = new pg.Client({ connectionString: LOGS_URL });
let source: pg.Client;

beforeAll(async () => {
  await logs.connect();
  const level = (
    await logs.query<{ level: string }>("SELECT current_setting('wal_level') AS level")
  ).rows[0]?.level;
  if (level !== "logical")
    throw new Error(`the logs cluster needs wal_level=logical, not ${String(level)}`);
  await logs.query(`DROP DATABASE IF EXISTS ${SOURCE}`);
  await logs.query(`CREATE DATABASE ${SOURCE}`);
  source = new pg.Client({ connectionString: sourceUrl() });
  await source.connect();
  await source.query(`
    CREATE TABLE public.log_chain_base (only_row boolean PRIMARY KEY, seq bigint NOT NULL, hash bytea NOT NULL);
    CREATE TABLE public.base_replication_probe (n int PRIMARY KEY);
    CREATE PUBLICATION base_replication FOR TABLE public.log_chain_base, public.base_replication_probe`);
  await logs.query("CREATE TABLE public.base_replication_probe (n int PRIMARY KEY)");
});

afterAll(async () => {
  await source?.end();
  await logs.query("DROP TABLE IF EXISTS public.base_replication_probe");
  await logs.query(`DROP DATABASE IF EXISTS ${SOURCE}`);
  await logs.end();
});

async function base(): Promise<{ seq: string; hash: Buffer }[]> {
  return (await logs.query("SELECT seq, hash FROM public.log_chain_base")).rows;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("logical replication apply leaves the chain base as it is", () => {
  it.each([
    ["UPDATE", "UPDATE public.log_chain_base SET seq = 5, hash = decode(repeat('ab', 32), 'hex')"],
    ["DELETE", "DELETE FROM public.log_chain_base"],
    ["TRUNCATE", "TRUNCATE public.log_chain_base"],
  ])(
    "a replicated %s is refused",
    async (op, write) => {
      const name = `base_replication_${op.toLowerCase()}`;
      const probe = ["UPDATE", "DELETE", "TRUNCATE"].indexOf(op) + 1;
      await source.query("TRUNCATE public.log_chain_base");
      await source.query("INSERT INTO public.log_chain_base VALUES (true, 0, $1)", [ZERO]);
      await source.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [name]);
      await logs.query(
        `CREATE SUBSCRIPTION ${name} CONNECTION '${sourceUrl()}' PUBLICATION base_replication
       WITH (create_slot = false, slot_name = '${name}', copy_data = false, run_as_owner = true, disable_on_error = true)`,
      );
      try {
        await source.query("INSERT INTO public.base_replication_probe VALUES ($1)", [probe]);
        await source.query(write);
        await until(
          async () =>
            (
              await logs.query(
                "SELECT 1 FROM pg_subscription s WHERE s.subname = $1 AND NOT s.subenabled AND EXISTS (SELECT 1 FROM public.base_replication_probe WHERE n = $2)",
                [name, probe],
              )
            ).rowCount === 1,
          `the probe row and the subscription ${name} stopped by the error`,
        );
        expect(await base()).toStrictEqual([{ seq: "0", hash: ZERO }]);
      } finally {
        await logs.query(`ALTER SUBSCRIPTION ${name} DISABLE`);
        await logs.query(`ALTER SUBSCRIPTION ${name} SET (slot_name = NONE)`);
        await logs.query(`DROP SUBSCRIPTION ${name}`);
        await source.query("SELECT pg_drop_replication_slot($1)", [name]);
      }
    },
    60_000,
  );
});
