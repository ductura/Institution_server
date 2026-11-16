// S-1K.2-b (DAN-816) against the real logs database (CI: 127.0.0.1:54330,
// migrated by scripts/db/migrate-locked.ts --database logs): appends from
// several connections at once keep one chain, with no gap and no fork
// (ductura/server#125, B1-B4), and the chain migration stops on a log table
// that already holds rows (E3). The appends commit, as only committed rows show
// how connections queue; they are synthetic (kind test.chain_*) and
// db/logs/tests counts its own rows from the head it finds. With no database
// it fails, it never skips.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { upSection } from "./cluster.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The log chain test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);
const MIGRATION = fileURLToPath(
  new URL("../../db/logs/migrations/20261116170000_log_chain.sql", import.meta.url),
);
const logs = new pg.Pool({ connectionString: LOGS_URL, max: 12 });
afterAll(() => logs.end());

type Row = { seq: string; prevHash: Buffer; hash: Buffer; payload: { run: string; n: number } };

/** Opens a transaction as the writer on a connection of its own. */
async function writer(isolation = "READ COMMITTED"): Promise<pg.PoolClient> {
  const client = await logs.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query("SET LOCAL ROLE ductus_logs_writer");
  return client;
}

function append(client: pg.PoolClient, run: string, n: number): Promise<unknown> {
  return client.query(
    "INSERT INTO public.log_entry (kind, payload) VALUES ('test.chain_append', $1)",
    [JSON.stringify({ run, n })],
  );
}

/**
 * In one transaction: the rows of `run` in chain order as the owner (the reader
 * holds no right on log_entry or the head, DAN-835-4) and the head, then the verification as the reader.
 */
async function read(run: string) {
  const client = await logs.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL ROLE ductus_logs_migrator");
    const rows = (
      await client.query<Row>(
        "SELECT seq, prev_hash AS \"prevHash\", hash, payload FROM public.log_entry WHERE payload->>'run' = $1 ORDER BY seq",
        [run],
      )
    ).rows;
    const head = (await client.query<{ seq: string }>("SELECT seq FROM public.log_chain_head"))
      .rows[0];
    await client.query("SET LOCAL ROLE ductus_logs_reader");
    const problems = (await client.query("SELECT seq, problem FROM public.log_chain_verify()"))
      .rows;
    return { rows, head: Number(head?.seq), problems };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function headSeq(): Promise<number> {
  return (await read("-")).head;
}

/** Resolves once the backend `pid` waits on a lock. */
async function waitsOnLock(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await logs.query<{ wait: string | null }>(
      "SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.wait === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

const pidOf = async (client: pg.PoolClient) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
const newRun = () => randomBytes(6).toString("hex");

describe("the log chain under concurrent appends", () => {
  it("B1: a second append waits for the first and chains on it once it commits", async () => {
    const run = newRun();
    const first = await writer();
    const second = await writer();
    try {
      await append(first, run, 1);
      const pid = await pidOf(second);
      const waiting = append(second, run, 2);
      await waitsOnLock(pid);
      await first.query("COMMIT");
      await waiting;
      await second.query("COMMIT");
    } finally {
      first.release();
      second.release();
    }
    const { rows, head, problems } = await read(run);
    expect(rows.map((r) => r.payload.n)).toEqual([1, 2]);
    expect(Number(rows[1]!.seq)).toBe(Number(rows[0]!.seq) + 1);
    expect(rows[1]!.prevHash.equals(rows[0]!.hash)).toBe(true);
    expect(head).toBe(Number(rows[1]!.seq));
    expect(problems).toEqual([]);
  });

  it("B2: when the first rolls back, the waiting append takes its place and leaves no gap", async () => {
    const run = newRun();
    const before = await headSeq();
    const first = await writer();
    const second = await writer();
    try {
      await append(first, run, 1);
      const pid = await pidOf(second);
      const waiting = append(second, run, 2);
      await waitsOnLock(pid);
      await first.query("ROLLBACK");
      await waiting;
      await second.query("COMMIT");
    } finally {
      first.release();
      second.release();
    }
    const { rows, head, problems } = await read(run);
    expect(rows.map((r) => [Number(r.seq), r.payload.n])).toEqual([[before + 1, 2]]);
    expect(head).toBe(before + 1);
    expect(problems).toEqual([]);
  });

  it("B3: many appends over many connections at once take consecutive places, each once", async () => {
    const run = newRun();
    const before = await headSeq();
    const count = 48;
    await Promise.all(
      Array.from({ length: count }, async (_, n) => {
        const client = await writer();
        try {
          await append(client, run, n);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }),
    );
    const { rows, head, problems } = await read(run);
    expect(rows.map((r) => Number(r.seq))).toEqual(
      Array.from({ length: count }, (_, i) => before + 1 + i),
    );
    expect(new Set(rows.map((r) => r.payload.n)).size).toBe(count);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevHash.equals(rows[i - 1]!.hash)).toBe(true);
    }
    expect(head).toBe(before + count);
    expect(problems).toEqual([]);
  });

  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
    it(`B4: under ${isolation}, an append that saw the head before another committed fails with 40001 rather than fork`, async () => {
      const run = newRun();
      const late = await writer(isolation);
      try {
        await late.query("SELECT 1"); // the snapshot
        const first = await writer();
        try {
          await append(first, run, 1);
          await first.query("COMMIT");
        } finally {
          first.release();
        }
        await expect(append(late, run, 2)).rejects.toMatchObject({ code: "40001" });
      } finally {
        await late.query("ROLLBACK");
        late.release();
      }
      const { rows, problems } = await read(run);
      expect(rows.map((r) => r.payload.n)).toEqual([1]);
      expect(problems).toEqual([]);
    });
  }
});

describe("the chain migration", () => {
  it("E3: stops on a log table that already holds rows, rather than invent a chain for them", async () => {
    const down = readFileSync(MIGRATION, "utf8").split("-- migrate:down")[1]!;
    const client = await logs.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE ductus_logs_migrator");
      await client.query(down);
      await client.query("SET LOCAL ROLE ductus_logs_writer");
      await client.query(
        "INSERT INTO public.log_entry (kind, payload) VALUES ('test.chain_before', '{}')",
      );
      await client.query("SET LOCAL ROLE ductus_logs_migrator");
      await expect(client.query(upSection(MIGRATION))).rejects.toMatchObject({ code: "23502" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await read("-")).problems).toEqual([]);
  });
});
