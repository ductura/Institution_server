import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { parse } from "yaml";

import type { Database } from "../../scripts/db/index.ts";
import type { TestDatabase } from "./create-test-database.ts";

// S-1F-e (DAN-785): the real PostgreSQL side of createTestDatabase. It opens
// the database of the entry that `pnpm db:migrate` (or the CI job `database`)
// has already migrated; it migrates nothing. Every test runs in one
// transaction that reset() and close() roll back, so nothing a test does,
// SET ROLE included, outlives it. A test that needs a commit or a second login
// stays in tests/db (project `database`).
//
// One connection serves the whole handle, so its calls take turns, as on a
// pool of one connection (ZEL-SRV-PG-TESTNA-VEZA): every query() and exec()
// is SAVEPOINT, the call and RELEASE as one unit, and a test that sets a
// token or a role around several calls (a withActor) runs them as one turn
// with exclusive(). Production takes a connection per call.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const LOCAL_PORTS = new Set(["54329", "54330", "5432"]);

type ComposeService = { ports?: string[]; environment?: Record<string, string> };

/**
 * The superuser URL of `target` from compose.yaml: the published port and the
 * public local-only POSTGRES_USER and POSTGRES_PASSWORD of its service, which
 * CI uses too. Only a loopback URL on a local port passes.
 */
export function adminUrl(target: Database, compose: string): string {
  const services = (parse(compose) as { services?: Record<string, ComposeService> }).services;
  const service = services?.[target.service];
  const port = /^127\.0\.0\.1:(\d+):5432$/u.exec(service?.ports?.[0] ?? "")?.[1];
  // F-019: only this machine, on a local port (as tests/db/loopback-database-url.ts).
  if (port !== undefined && !LOCAL_PORTS.has(port)) {
    throw new Error(`${target.name}: port ${port} is not a local database port`);
  }
  const user = service?.environment?.["POSTGRES_USER"];
  const password = service?.environment?.["POSTGRES_PASSWORD"];
  if (port === undefined || user === undefined || password === undefined) {
    throw new Error(`compose.yaml: service ${target.service} has no local port or superuser`);
  }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(target.database)}`;
}

// The applied versions are checked once per database and process.
const checked = new Map<string, Promise<void>>();

// A database a test committed to is no longer the migrated one. The table is
// committed on purpose, so every later open fails, in any process, until
// `pnpm db:migrate` starts from a fresh database (adversarial pass, DAN-785).
const DIRTY = "public.ductura_test_committed";

async function checkMigrated(client: pg.Client, target: Database): Promise<void> {
  const files = readdirSync(resolve(ROOT, target.migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => /^(\d+)_/u.exec(name)?.[1] ?? name)
    .sort();
  const applied = await client.query<{ version: string }>(
    "SELECT version FROM public.schema_migrations ORDER BY version",
  );
  const versions = applied.rows.map((row) => row.version);
  if (JSON.stringify(versions) !== JSON.stringify(files)) {
    throw new Error(
      `${target.name}: ${target.database} is not migrated to db/${target.name}/migrations (run pnpm db:migrate)`,
    );
  }
}

// Settings a client may send at connection (PGOPTIONS) that a test must not
// inherit; the driver itself sends only these two.
const CLIENT_SETTINGS =
  "SELECT name FROM pg_catalog.pg_settings WHERE source = 'client' AND name NOT IN ('application_name', 'client_encoding')";

// Sequences are not transactional: reset() puts them back as they were.
const SEQUENCES = `SELECT pg_catalog.format('%I.%I', schemaname, sequencename) AS name,
  COALESCE(last_value, start_value)::text AS value, (last_value IS NOT NULL) AS called
  FROM pg_catalog.pg_sequences`;

type Sequence = { name: string; value: string; called: boolean };

// One baseline per database while any handle to it is open, so a second
// handle never takes the sequences the first one moved as its baseline
// (Codex review c.4579724007).
const baselines = new Map<string, { sequences: Sequence[]; handles: number }>();

// The savepoint around every call: rolling back to it proves the call left
// the test's own transaction in place (Codex review c.4579724002).
const CALL = "ductura_test_call";

// The turns of every open handle (exclusive, settled).
const turns = new WeakMap<TestDatabase, Turns>();

type Turns = {
  /** `work` as one turn; inside a turn of the same handle, part of it. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** One call: after the earlier calls of the turn that holds it, else a turn of its own. */
  call<T>(work: () => Promise<T>): Promise<T>;
  settled(): Promise<void>;
};

// The turn the running code holds, and whether that turn is still on.
const holding = new AsyncLocalStorage<{ readonly turns: Turns; on: boolean }>();

function turnsOf(db: TestDatabase): Turns {
  const found = turns.get(db);
  if (found === undefined) throw new Error(`${db.name}: not an open PostgreSQL test database`);
  return found;
}

/**
 * Runs `work` as one turn on the one connection of `db`: every other call of
 * the handle waits until it ends, and the calls inside it go in order. A turn
 * inside a turn of the same handle is part of it. Something `work` leaves
 * running after it ends waits for a turn of its own.
 */
export function exclusive<T>(db: TestDatabase, work: () => Promise<T>): Promise<T> {
  return turnsOf(db).exclusive(work);
}

/** Resolves once no turn of `db` waits or runs, turns queued meanwhile included. */
export function settled(db: TestDatabase): Promise<void> {
  return turnsOf(db).settled();
}

const ignore = (): void => undefined;

function createTurns(): Turns {
  let turn: Promise<unknown> = Promise.resolve();
  let calls: Promise<unknown> = Promise.resolve();
  const holds = (): boolean => {
    const held = holding.getStore();
    return held?.turns === self && held.on;
  };
  const self: Turns = {
    exclusive: (work) => {
      if (holds()) return work();
      // A call an earlier turn left running ends first.
      const mine = turn.then(async () => {
        await calls;
        const store = { turns: self, on: true };
        try {
          return await holding.run(store, work);
        } finally {
          store.on = false;
        }
      });
      turn = mine.then(ignore, ignore);
      return mine;
    },
    call: (work) => {
      if (!holds()) return self.exclusive(work);
      const mine = calls.then(work);
      calls = mine.then(ignore, ignore);
      return mine;
    },
    settled: async () => {
      for (let last = turn; ; last = turn) {
        await last;
        if (last === turn) return;
      }
    },
  };
  return self;
}

/** The migrated database of `target`, one transaction per test. */
export async function openPostgresDatabase(target: Database): Promise<TestDatabase> {
  const client = new pg.Client({
    connectionString: adminUrl(target, readFileSync(resolve(ROOT, "compose.yaml"), "utf8")),
    application_name: `ductura-test-${target.name}`,
  });
  await client.connect();
  let xid = "";
  let baseline: { sequences: Sequence[]; handles: number } | undefined;
  const txid = async (): Promise<string> =>
    (await client.query<{ x: string }>("SELECT pg_catalog.txid_current()::text AS x")).rows[0]
      ?.x as string;
  const begin = async (): Promise<void> => {
    await client.query("BEGIN");
    xid = await txid();
  };
  // Back to the session the test got: no prepared statement, advisory lock,
  // temporary object or setting, and every sequence where it was.
  const rollback = async (): Promise<void> => {
    await client.query("ROLLBACK");
    await client.query("DISCARD ALL");
    for (const { name, value, called } of baseline?.sequences ?? [])
      await client.query("SELECT pg_catalog.setval($1::regclass, $2::bigint, $3)", [
        name,
        value,
        called,
      ]);
  };
  // The test's SQL ended its transaction: the database is marked for good.
  // DISCARD ALL first, so a role the test set after its COMMIT cannot stop
  // the marker (Codex review c.4579724004).
  const committed = async (): Promise<never> => {
    let marker: unknown = null;
    try {
      await client.query("ROLLBACK");
      await client.query("DISCARD ALL");
      await client.query(`CREATE TABLE IF NOT EXISTS ${DIRTY} ()`);
    } catch (error) {
      marker = error;
    }
    if (marker !== null)
      throw new Error("the test ended its own transaction, and the database could not be marked", {
        cause: marker,
      });
    throw new Error("the test ended its own transaction; its changes may be committed");
  };
  // Every call runs after SAVEPOINT; afterwards the transaction must be the
  // same one. A failed call is rolled back to the savepoint, which exists only
  // in the test's own transaction, so a COMMIT; BEGIN; <error> is caught too.
  const run = async <T>(sql: string, params?: unknown[]): Promise<pg.QueryResult> => {
    await client.query(`SAVEPOINT ${CALL}`);
    let failure: unknown = null;
    let result: pg.QueryResult | null = null;
    try {
      result = await client.query(sql, params);
    } catch (error) {
      failure = error;
    }
    if (failure !== null) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${CALL}`);
      } catch {
        return committed();
      }
    }
    let now: string;
    try {
      now = await txid();
    } catch {
      return committed();
    }
    if (now !== xid) return committed();
    await client.query(`RELEASE SAVEPOINT ${CALL}`).catch(() => committed());
    if (failure !== null) throw failure;
    return result as pg.QueryResult<T & pg.QueryResultRow>;
  };
  try {
    const settings = await client.query<{ name: string }>(CLIENT_SETTINGS);
    if (settings.rows.length > 0)
      throw new Error(
        `connection settings from the client: ${settings.rows.map((row) => row.name).join(", ")} (PGOPTIONS?)`,
      );
    const marked = await client.query<{ t: string | null }>(
      `SELECT pg_catalog.to_regclass('${DIRTY}')::text AS t`,
    );
    if (marked.rows[0]?.t !== null)
      throw new Error(`${target.name}: an earlier test committed to it; migrate a fresh database`);
    let check = checked.get(`${target.name}\0${target.migrationsDir}`);
    if (check === undefined) {
      check = checkMigrated(client, target);
      checked.set(`${target.name}\0${target.migrationsDir}`, check);
    }
    await check;
    baseline = baselines.get(target.name);
    if (baseline === undefined) {
      baseline = { sequences: (await client.query<Sequence>(SEQUENCES)).rows, handles: 0 };
      baselines.set(target.name, baseline);
    }
    baseline.handles += 1;
    await begin();
  } catch (error) {
    await client.end();
    throw error;
  }
  const opened = baseline;
  const queue = createTurns();
  const handle: TestDatabase = {
    name: target.name,
    engine: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: (await queue.call(() => run<T>(sql, params))).rows as T[],
    }),
    exec: async (sql) => {
      await queue.call(() => run(sql));
    },
    reset: () =>
      queue.call(async () => {
        await rollback();
        await begin();
      }),
    close: () =>
      queue.call(async () => {
        try {
          await rollback();
        } finally {
          await client.end();
          opened.handles -= 1;
          if (opened.handles === 0) baselines.delete(target.name);
        }
      }),
  };
  turns.set(handle, queue);
  return handle;
}
