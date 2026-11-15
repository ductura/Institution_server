import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { checkLedger, DIR, LEDGER, readMigrations } from "../../../scripts/db/index.ts";

// U9-b (DAN-741): a migrated main database in PGlite, one per call. Only for
// unit and fast integration tests: privileges, RLS, SECURITY DEFINER, pgTAP,
// races and pg-boss stay on real PostgreSQL (S-0.3, Ductus#2003,
// spikes/pglite/NALAZI.md §5). The migrations come from the directory dbmate
// gets (scripts/db/migrate-locked.ts) and are checked against its ledger.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where the migrations and their ledger are, as absolute paths. */
export type MigrationSource = { readonly dir: string; readonly ledger: string };

export const MAIN_SOURCE: MigrationSource = {
  dir: join(ROOT, DIR),
  ledger: join(ROOT, LEDGER),
};

const LOCAL = join(ROOT, "db", "main", "local");
const NAME_RE = /^(\d+)_[^/\\]+\.sql$/u;
const UP = "-- migrate:up";
// dbmate reads the markers only at the start of a line.
const UP_RE = /^--\s*migrate:up(?:[ \t]+(\S.*))?[ \t]*$/mu;
const DOWN_RE = /^--\s*migrate:down(?:\s*$|\s+\S)/mu;

export type Migration = { readonly name: string; readonly version: string; readonly up: string };

/** The part dbmate runs on `up`: from `-- migrate:up` to `-- migrate:down`. */
export function upSection(name: string, sql: string): string {
  const up = UP_RE.exec(sql);
  if (up === null) throw new Error(`${name}: no "${UP}" marker`);
  // dbmate runs every migration in a transaction unless told otherwise; this
  // fake knows only that default.
  const options = up[1]?.trim() ?? "";
  if (options !== "") throw new Error(`${name}: unsupported dbmate option "${options}"`);
  const rest = sql.slice(up.index);
  const end = DOWN_RE.exec(rest)?.index;
  return rest.slice(0, end);
}

/** Every migration of `source`, in file name order, after the ledger matches the bytes. */
export function loadMigrations(source: MigrationSource): Migration[] {
  const files = readMigrations(source.dir);
  let ledgerText: string | null = null;
  try {
    ledgerText = readFileSync(source.ledger, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const errors = checkLedger(files, ledgerText);
  if (errors.length > 0)
    throw new Error(`migrations do not match the ledger: ${errors.join("; ")}`);
  return [...files.keys()].sort().map((name) => {
    const version = NAME_RE.exec(name)?.[1];
    if (version === undefined) throw new Error(`${name}: not "<version>_<name>.sql"`);
    return { name, version, up: upSection(name, (files.get(name) as Buffer).toString("utf8")) };
  });
}

export const MIGRATOR = "ductus_migrator";

/** The same database, reopened in memory with `username` as its session user. */
export async function reopen(db: PGlite, username?: string): Promise<PGlite> {
  const dump = await db.dumpDataDir("none");
  await db.close();
  const next = new PGlite(
    username === undefined ? { loadDataDir: dump } : { loadDataDir: dump, username },
  );
  await next.waitReady;
  return next;
}

/**
 * Applies each migration in its own transaction. As with dbmate and `role=`,
 * ductus_migrator must be the session's own role, so that RESET ROLE inside a
 * migration returns to it and nothing runs as the superuser; a COMMIT inside a
 * migration would break the all-or-nothing file, so it is refused.
 */
export async function applyMigrations(db: PGlite, migrations: readonly Migration[]): Promise<void> {
  const session = await db.query<{ u: string }>("SELECT session_user AS u");
  if (session.rows[0]?.u !== MIGRATOR)
    throw new Error(`migrations run with ${MIGRATOR} as the session user`);
  const xact = async (): Promise<string> =>
    String(
      (await db.query<{ x: string }>("SELECT pg_catalog.pg_current_xact_id()::text AS x")).rows[0]
        ?.x,
    );
  for (const migration of migrations) {
    await db.exec("BEGIN");
    try {
      // A migration cannot forge its transaction id, so a COMMIT inside it shows.
      const before = await xact();
      await db.exec(migration.up);
      if ((await xact()) !== before) throw new Error("ends its own transaction");
      await db.exec("RESET ROLE");
      await db.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`${migration.name}: ${(error as Error).message}`, { cause: error });
    }
  }
  // The returned database is the superuser's: the ledger it reads must stay a
  // plain table of the migrator, not a view or rule a migration put there.
  const ledger = await db.query<{ ok: boolean }>(
    `SELECT c.relkind = 'r' AND pg_catalog.pg_get_userbyid(c.relowner) = '${MIGRATOR}'
            AND NOT c.relhasrules AND NOT c.relhastriggers AS ok
       FROM pg_catalog.pg_class c WHERE c.oid = 'public.schema_migrations'::regclass`,
  );
  if (ledger.rows[0]?.ok !== true)
    throw new Error(`public.schema_migrations is no longer a plain table of ${MIGRATOR}`);
}

export type PgliteDatabase = { readonly db: PGlite; close(): Promise<void> };

/** A new in-memory main database with the local roles and every migration of `source`. */
export async function createFromSource(source: MigrationSource): Promise<PgliteDatabase> {
  const migrations = loadMigrations(source);
  let db = new PGlite();
  try {
    await db.waitReady;
    // The parts of `pnpm db:migrate` (package.json) the main database needs
    // here; the worker and auth login roles are not provisioned.
    await db.exec(readFileSync(join(LOCAL, "migrator.sql"), "utf8"));
    await db.exec(
      `SET ROLE ${MIGRATOR}; CREATE TABLE public.schema_migrations (version varchar(128) PRIMARY KEY); RESET ROLE;`,
    );
    db = await reopen(db, MIGRATOR);
    await applyMigrations(db, migrations);
    db = await reopen(db);
    await db.exec(readFileSync(join(LOCAL, "app-login.sql"), "utf8"));
  } catch (error) {
    if (!db.closed) await db.close();
    throw error;
  }
  const result = db;
  return { db: result, close: () => result.close() };
}

export type PgliteDatabaseOptions = { readonly database: "main" };

/**
 * A migrated database in memory, a new one for every call. Only "main" has
 * migrations so far; the logs and legal databases follow with theirs (S-1F).
 */
export function createPgliteDatabase(
  options: PgliteDatabaseOptions = { database: "main" },
): Promise<PgliteDatabase> {
  if (options.database !== "main") {
    return Promise.reject(new Error(`no migrations for database "${String(options.database)}"`));
  }
  return createFromSource(MAIN_SOURCE);
}
