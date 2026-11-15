import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  checkLedger,
  type Database,
  databaseNamed,
  DIR,
  LEDGER,
  readMigrations,
} from "../../../scripts/db/index.ts";

// U9-b (DAN-741): a migrated database in PGlite, one per call. Only for
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

/** A PGlite in memory from `dump`, connected to `database` as `username` (default: superuser). */
export async function openDump(dump: Blob, database?: string, username?: string): Promise<PGlite> {
  const next = new PGlite({
    loadDataDir: dump,
    ...(database === undefined ? {} : { database }),
    ...(username === undefined ? {} : { username }),
  });
  await next.waitReady;
  return next;
}

/** The same cluster, reopened in memory in `database` with `username` as its session user. */
export async function reopen(db: PGlite, username?: string, database?: string): Promise<PGlite> {
  const dump = await db.dumpDataDir("none");
  await db.close();
  return openDump(dump, database, username);
}

/**
 * Applies each migration in its own transaction. As with dbmate and `role=`,
 * ductus_migrator must be the session's own role, so that RESET ROLE inside a
 * migration returns to it and nothing runs as the superuser; a COMMIT inside a
 * migration would break the all-or-nothing file, so it is refused.
 */
export async function applyMigrations(
  db: PGlite,
  migrations: readonly Migration[],
  migrator: string = MIGRATOR,
): Promise<void> {
  const session = await db.query<{ u: string }>("SELECT session_user AS u");
  if (session.rows[0]?.u !== migrator)
    throw new Error(`migrations run with ${migrator} as the session user`);
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
    `SELECT c.relkind = 'r' AND pg_catalog.pg_get_userbyid(c.relowner) = $1
            AND NOT c.relhasrules AND NOT c.relhastriggers AS ok
       FROM pg_catalog.pg_class c WHERE c.oid = 'public.schema_migrations'::regclass`,
    [migrator],
  );
  if (ledger.rows[0]?.ok !== true)
    throw new Error(`public.schema_migrations is no longer a plain table of ${migrator}`);
}

export type PgliteDatabase = { readonly db: PGlite; close(): Promise<void> };

/** What the fake needs of an entry of scripts/db/databases.ts. */
export type PgliteTarget = Pick<Database, "name" | "database" | "migrationsDir" | "migrator">;

const MAIN = databaseNamed("main");

/** The local file next to the migrations (db/<name>/local/<file>), or null; paths may be absolute. */
function localSql(target: PgliteTarget, file: string): string | null {
  try {
    return readFileSync(resolve(ROOT, target.migrationsDir, "..", "local", file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The migrated cluster of `target` as a dump. As CI does it: CREATE DATABASE
 * as the superuser, local/migrator.sql (it hands the database to the
 * migrator), the migrations with the migrator as session user, then
 * local/app-login.sql if the database has one. The worker and auth login
 * roles of the main database are not provisioned.
 */
export async function migratedDump(
  source: MigrationSource,
  target: PgliteTarget = MAIN,
): Promise<Blob> {
  const migrations = loadMigrations(source);
  const migratorSql = localSql(target, "migrator.sql");
  if (migratorSql === null) throw new Error(`${target.name}: no local/migrator.sql`);
  let db = new PGlite();
  try {
    await db.waitReady;
    // CREATE DATABASE cannot run in exec's implicit transaction with others.
    await db.exec(`CREATE DATABASE "${target.database.replaceAll('"', '""')}"`);
    db = await reopen(db, undefined, target.database);
    await db.exec(migratorSql);
    await db.exec(
      `SET ROLE ${target.migrator}; CREATE TABLE IF NOT EXISTS public.schema_migrations (version varchar PRIMARY KEY); RESET ROLE;`,
    );
    db = await reopen(db, target.migrator, target.database);
    await applyMigrations(db, migrations, target.migrator);
    db = await reopen(db, undefined, target.database);
    const login = localSql(target, "app-login.sql");
    if (login !== null) await db.exec(login);
    const dump = await db.dumpDataDir("none");
    await db.close();
    return dump;
  } catch (error) {
    if (!db.closed) await db.close();
    throw error;
  }
}

/** A new in-memory database with the local roles and every migration of `source`. */
export async function createFromSource(
  source: MigrationSource,
  target: PgliteTarget = MAIN,
): Promise<PgliteDatabase> {
  const db = await openDump(await migratedDump(source, target), target.database);
  return { db, close: () => db.close() };
}

/** Where `target` keeps its migrations and ledger, as absolute paths. */
export function sourceOf(target: Pick<Database, "migrationsDir" | "ledger">): MigrationSource {
  return { dir: resolve(ROOT, target.migrationsDir), ledger: resolve(ROOT, target.ledger) };
}

export type PgliteDatabaseOptions = { readonly database: string };

/**
 * A migrated database in memory, a new one for every call: any name of
 * scripts/db/databases.ts (main, logs, legal and every later one); an unknown
 * name is an error, never a default.
 */
export async function createPgliteDatabase(
  options: PgliteDatabaseOptions = { database: "main" },
): Promise<PgliteDatabase> {
  const target = databaseNamed(options.database);
  return createFromSource(sourceOf(target), target);
}
