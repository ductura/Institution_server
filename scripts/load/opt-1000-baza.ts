// SRV-OPT-1000 (DAN-895): samples the load of the database and the length of
// the job queues while a k6 run is going, on a machine apart from both the
// generator and the server. Read-only: it runs only SELECTs on the standard
// statistics views and pgboss.job, and writes one CSV row per interval to
// .local/load/ (git-ignored). It uses psql (as scripts/lokalno does), not a
// pg client, because database access goes through server/database only. The URL
// reaches psql through PGDATABASE, never through the argument list. The URL is never printed and never read from a
// default: it has to be given, so the script cannot aim at a database by luck.
//
//   node scripts/load/opt-1000-baza.ts --baza-env=MJERENJE_DATABASE_URL --oznaka=pisci-w1-r1 --interval=5 --trajanje=600

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { LOCAL_DIR } from "../lokalno/index.ts";

export type Sample = {
  second: number;
  connections: number;
  active: number;
  waiting: number;
  commits: number;
  rollbacks: number;
  queued: number;
  activeJobs: number;
  oldestQueuedSeconds: number;
};

export const CSV_HEADER =
  "sekunda,veze,aktivne,cekaju,commitovi_ukupno,rollbackovi_ukupno,u_redu,aktivni_poslovi,najstariji_u_redu_s";

export const SAMPLE_QUERIES = {
  sessions: `SELECT count(*)::int AS connections,
                    count(*) FILTER (WHERE state = 'active')::int AS active,
                    count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting
               FROM pg_stat_activity WHERE datname = current_database()`,
  transactions: `SELECT xact_commit::bigint AS commits, xact_rollback::bigint AS rollbacks
                   FROM pg_stat_database WHERE datname = current_database()`,
  queue: `SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
                 count(*) FILTER (WHERE state = 'active')::int AS "activeJobs",
                 coalesce(extract(epoch FROM now() - min(created_on)
                   FILTER (WHERE state IN ('created', 'retry'))), 0)::int AS oldest
            FROM pgboss.job WHERE state IN ('created', 'retry', 'active')`,
} as const;

export function toCsvRow(sample: Sample): string {
  return [
    sample.second,
    sample.connections,
    sample.active,
    sample.waiting,
    sample.commits,
    sample.rollbacks,
    sample.queued,
    sample.activeJobs,
    sample.oldestQueuedSeconds,
  ].join(",");
}

type Flags = { urlEnv: string; label: string; intervalS: number; durationS: number };

export function parseFlags(argv: readonly string[]): Flags {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const urlEnv = value("baza-env") ?? "";
  const label = value("oznaka") ?? "";
  const intervalS = Number(value("interval") ?? "5");
  const durationS = Number(value("trajanje") ?? "600");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(urlEnv)) throw new Error("--baza-env must name a variable");
  if (!/^[a-z0-9-]{1,40}$/u.test(label)) throw new Error("--oznaka must be 1 to 40 of a-z, 0-9, -");
  if (!Number.isSafeInteger(intervalS) || intervalS < 1 || intervalS > 60)
    throw new Error("--interval must be 1 to 60");
  if (!Number.isSafeInteger(durationS) || durationS < intervalS || durationS > 7_200)
    throw new Error("--trajanje must be from the interval to 7200");
  return { urlEnv, label, intervalS, durationS };
}

const run = promisify(execFile);

/** The three queries as one statement: one round trip, one row of nine numbers. */
const ONE_ROW = `SELECT * FROM (${SAMPLE_QUERIES.sessions}) a, (${SAMPLE_QUERIES.transactions}) b, (${SAMPLE_QUERIES.queue}) c`;

async function sample(url: string, second: number): Promise<Sample> {
  const { stdout } = await run(
    "psql",
    ["-X", "-A", "-t", "-F", ",", "-v", "ON_ERROR_STOP=1", "-c", ONE_ROW],
    {
      env: Object.fromEntries([
        ["PATH", process.env["PATH"] ?? ""],
        ["PGDATABASE", url],
        ["PGCONNECT_TIMEOUT", "5"],
        ["PGOPTIONS", "-c statement_timeout=3000"],
      ]),
      timeout: 10_000,
    },
  );
  const [connections, active, waiting, commits, rollbacks, queued, activeJobs, oldest] = stdout
    .trim()
    .split(",")
    .map(Number);
  const values = [connections, active, waiting, commits, rollbacks, queued, activeJobs, oldest];
  if (values.length !== 8 || values.some((value) => value === undefined || Number.isNaN(value)))
    throw new Error("unexpected sample");
  return {
    second,
    connections: connections ?? 0,
    active: active ?? 0,
    waiting: waiting ?? 0,
    commits: commits ?? 0,
    rollbacks: rollbacks ?? 0,
    queued: queued ?? 0,
    activeJobs: activeJobs ?? 0,
    oldestQueuedSeconds: oldest ?? 0,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const url = process.env[flags.urlEnv];
  if (url === undefined || url === "") throw new Error(`${flags.urlEnv} is not set`);
  const rows = [CSV_HEADER];
  const started = Date.now();
  const dir = join(LOCAL_DIR, "load");
  mkdirSync(dir, { recursive: true });
  try {
    for (let elapsed = 0; elapsed <= flags.durationS; elapsed += flags.intervalS) {
      rows.push(toCsvRow(await sample(url, Math.round((Date.now() - started) / 1000))));
      await new Promise((resolve) => setTimeout(resolve, flags.intervalS * 1000));
    }
  } finally {
    writeFileSync(join(dir, `baza-${flags.label}.csv`), `${rows.join("\n")}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`baza: ${error instanceof Error ? error.message : "nepoznata pogreška"}`);
    process.exit(1);
  });
}
