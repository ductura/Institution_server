// D-91 (3), DAN-71: dbmate does not lock, so two runs against one database
// could apply migrations at the same time. This runner holds a session-level
// pg_advisory_lock on its own connection for the whole dbmate run and stops
// dbmate when that connection is lost (error, close or a heartbeat that fails
// or hangs). dbmate runs each migration in a transaction, so a stopped run
// rolls back the migration it was in. A lost lock always ends with exit 1,
// even when dbmate itself finished with 0. The child is the dbmate binary
// itself, not the npm wrapper (dist/cli.js runs it with spawnSync and would
// not pass a signal on). SIGINT or SIGTERM before dbmate starts cancels the
// run; the lock release and the closing of the connection are bounded too.
// Ported from Ductus scripts/db/migrate-locked.mjs and its migrate-locked.d.mts
// at d52a92c3 (S-0.13, DAN-726); only the paths and the types changed.
//
//   node scripts/db/migrate-locked.ts [--database <name>] --url <postgres-url>
//
// The URL is never printed. dbmate gets `up --strict` (D-91 (2)) and reads the
// migrations from db/main/migrations (its default is db/migrations). S-1F-c
// (DAN-779): --database picks another database of scripts/db/databases.ts
// (default main), and the URL must name that database and its migrator
// (`role=`), so one database's migrations never run in another.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveBinary } from "dbmate";

import { connectLockClient } from "../../server/database/index.ts";
import { databaseNamed, type Database } from "./databases.ts";

/** The one lock key of the Ductus migration runner (a fixed bigint). */
export const LOCK_KEY = "4207120261031";

/** Where dbmate reads the migrations of the main database, relative to the repository root. */
export const MIGRATIONS_DIR = "db/main/migrations";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type LockClient = EventEmitter & {
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
};

export type LockedChild = EventEmitter & {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
};

export type RunLockedOptions = {
  connect: () => Promise<LockClient>;
  start: () => LockedChild;
  signal?: AbortSignal;
  heartbeatMs?: number;
  lockTimeoutMs?: number;
  killGraceMs?: number;
  log?: (line: string) => void;
};

/** The dbmate binary for this platform (@dbmate/<platform>-<arch>), not the Node wrapper. */
export function dbmateBinary(): string {
  return resolveBinary();
}

/** The dbmate argv, program first: always `up --strict`, schema dump off, waiting for the server. */
export function dbmateArgs(url: string, migrationsDir: string = MIGRATIONS_DIR): string[] {
  return [
    dbmateBinary(),
    "--url",
    url,
    "--migrations-dir",
    migrationsDir,
    "--no-dump-schema",
    "--wait",
    "up",
    "--strict",
  ];
}

/**
 * The error for a URL that does not name `database` and run as its migrator,
 * or null. The message never contains the URL.
 */
export function urlMismatch(url: string, database: Database): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the URL is not a valid URL";
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name !== database.database) {
    return `the URL does not name the database ${database.database} of --database ${database.name}`;
  }
  const roles = parsed.searchParams.getAll("role");
  if (roles.length !== 1 || roles[0] !== database.migrator) {
    return `the URL must run as ${database.migrator} (one role=${database.migrator})`;
  }
  return null;
}

/** Starts dbmate as the runner's direct child, so a signal sent to the child reaches dbmate. */
export function startDbmate(
  url: string,
  options: SpawnOptions = {},
  migrationsDir: string = MIGRATIONS_DIR,
): ChildProcess {
  const [file, ...args] = dbmateArgs(url, migrationsDir);
  return spawn(file as string, args, {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

/** Resolves to true when `promise` fulfils within `ms`, false when it rejects or is still pending. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, ms, false);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Takes the lock on `connect()`'s client, then runs `start()` (a child process)
 * and returns its exit code, or 1 when the lock was not taken or was lost, the
 * release did not finish in time, or `signal` cancelled the run.
 */
export async function runLocked({
  connect,
  start,
  signal,
  heartbeatMs = 5000,
  lockTimeoutMs = 600_000,
  killGraceMs = 10_000,
  log = console.error,
}: RunLockedOptions): Promise<number> {
  if (signal?.aborted) {
    log("Migration run cancelled before dbmate started.");
    return 1;
  }
  let client: LockClient;
  try {
    client = await connect();
  } catch {
    log(
      signal?.aborted
        ? "Migration run cancelled before dbmate started."
        : "Migration lock: could not open the lock connection.",
    );
    return 1;
  }
  let failed = false;
  let done = false;
  let child: LockedChild | null = null;
  let exited = false;
  const stopChild = (): void => {
    if (!child || exited) return;
    const running = child;
    running.kill("SIGTERM");
    setTimeout(() => !exited && running.kill("SIGKILL"), killGraceMs).unref?.();
  };
  const lose = (why: string): void => {
    if (failed || done) return;
    failed = true;
    log(`Migration lock lost (${why}); stopping dbmate.`);
    stopChild();
  };
  // Cancelling while the lock is awaited ends the connection, which fails the
  // pending pg_advisory_lock; once dbmate runs, it is stopped like on a loss.
  const cancel = (): void => {
    if (failed || done) return;
    failed = true;
    log(
      child
        ? "Migration run cancelled; stopping dbmate."
        : "Migration run cancelled before dbmate started.",
    );
    if (child) stopChild();
    else client.end().catch(() => {});
  };
  client.on("error", () => lose("connection error"));
  client.on("end", () => lose("connection closed"));
  signal?.addEventListener("abort", cancel, { once: true });
  const finish = async (): Promise<void> => {
    done = true;
    signal?.removeEventListener("abort", cancel);
    // The session is gone either way once the process exits; the server then
    // releases the lock with it.
    await within(client.end(), killGraceMs);
  };
  // A signal that came while connect() was opening the connection fired before
  // the listener existed, so it is checked once more here.
  if (signal?.aborted) {
    log("Migration run cancelled before dbmate started.");
    await finish();
    return 1;
  }

  try {
    await client.query(`SET lock_timeout = ${Math.max(1, Math.trunc(Number(lockTimeoutMs)))}`);
    await client.query("SELECT pg_catalog.pg_advisory_lock($1::bigint)", [LOCK_KEY]);
  } catch {
    if (!failed) {
      log("Migration lock: could not take the lock (another run holds it, or the server refused).");
    }
    await finish();
    return 1;
  }
  if (failed) {
    await finish();
    return 1;
  }

  const running = start();
  child = running;
  let pending: number | null = null;
  const timer = setInterval(() => {
    if (pending) {
      if (Date.now() - pending > heartbeatMs * 3) lose("heartbeat timed out");
      return;
    }
    pending = Date.now();
    client.query("SELECT 1").then(
      () => {
        pending = null;
      },
      () => lose("heartbeat failed"),
    );
  }, heartbeatMs);
  const code = await new Promise<number>((resolve) => {
    running.once("error", () => resolve(1));
    running.once("exit", (exitCode: number | null) => resolve(exitCode ?? 1));
  });
  exited = true;
  clearInterval(timer);
  if (failed) {
    await finish();
    return 1;
  }
  // A connection that hangs now would hang the release; it gets the same
  // bound as a heartbeat, and a release that does not finish fails the run.
  const released = await within(
    client.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [LOCK_KEY]),
    heartbeatMs * 3,
  );
  if (!released && !failed) {
    failed = true;
    log("Migration lock: the release did not finish (connection lost or hung).");
  }
  await finish();
  if (failed) return 1;
  return code === 0 ? 0 : code || 1;
}

/** The database and URL of the argv, or an error message. */
export function parseArgs(argv: string[]): { database: Database; url: string } | string {
  const usage = "usage: migrate-locked.ts [--database <name>] --url <postgres-url>";
  let rest = argv;
  let database: Database;
  try {
    database = databaseNamed(rest[0] === "--database" ? (rest[1] ?? "") : "main");
  } catch (error) {
    return (error as Error).message;
  }
  if (rest[0] === "--database") rest = rest.slice(2);
  if (rest.length !== 2 || rest[0] !== "--url" || !rest[1]) return usage;
  const mismatch = urlMismatch(rest[1], database);
  return mismatch ?? { database, url: rest[1] };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }
  const { database, url } = parsed;
  const controller = new AbortController();
  let child: ChildProcess | null = null;
  // Before dbmate starts, a signal cancels the run (the runner must not start
  // migrations later); afterwards it goes to dbmate.
  const forward = (signal: NodeJS.Signals): void => {
    if (child) child.kill(signal);
    else controller.abort();
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return runLocked({
    connect: () => connectLockClient(url, { signal: controller.signal }),
    signal: controller.signal,
    start: () => {
      child = startDbmate(url, {}, database.migrationsDir);
      return child;
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
