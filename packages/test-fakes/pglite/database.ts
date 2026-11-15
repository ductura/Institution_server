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

// Objects owned by the bootstrap superuser, and superusers: a migration adds
// none, as the role it runs as cannot.
const SUPERUSER_FOOTPRINT = `SELECT
  (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner = 10)
  + (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner = 10)
  + (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = 10)
  + (SELECT count(*) FROM pg_catalog.pg_type WHERE typowner = 10)
  + (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolsuper) AS n`;

const footprint = async (db: PGlite): Promise<string> =>
  String((await db.query<{ n: string | number }>(SUPERUSER_FOOTPRINT)).rows[0]?.n);

/**
 * Applies each migration in its own transaction as ductus_migrator, as dbmate
 * with `role=`. There the role is the connection's, so RESET ROLE returns to
 * it; here SET LOCAL ends at RESET ROLE or COMMIT and the rest would run as the
 * superuser. So a COMMIT inside a migration, or anything it leaves owned by
 * the superuser, is refused.
 */
export async function applyMigrations(db: PGlite, migrations: readonly Migration[]): Promise<void> {
  for (const migration of migrations) {
    const before = await footprint(db);
    await db.exec(
      "BEGIN; SET LOCAL ROLE ductus_migrator; SET LOCAL ductura.fake_migration = 'on';",
    );
    try {
      await db.exec(migration.up);
      const inside = await db.query<{ on: string | null }>(
        "SELECT current_setting('ductura.fake_migration', true) AS on",
      );
      if (inside.rows[0]?.on !== "on") throw new Error("ends its own transaction");
      if ((await footprint(db)) !== before) throw new Error("ran as the superuser");
      await db.exec("SET LOCAL ROLE ductus_migrator");
      await db.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`${migration.name}: ${(error as Error).message}`, { cause: error });
    }
  }
}

export type PgliteDatabase = { readonly db: PGlite; close(): Promise<void> };

/** A new in-memory main database with the local roles and every migration of `source`. */
export async function createFromSource(source: MigrationSource): Promise<PgliteDatabase> {
  const migrations = loadMigrations(source);
  const db = new PGlite();
  try {
    await db.waitReady;
    // The parts of `pnpm db:migrate` (package.json) the main database needs
    // here; the worker and auth login roles are not provisioned.
    await db.exec(readFileSync(join(LOCAL, "migrator.sql"), "utf8"));
    await db.exec(
      "SET ROLE ductus_migrator; CREATE TABLE public.schema_migrations (version varchar(128) PRIMARY KEY); RESET ROLE;",
    );
    await applyMigrations(db, migrations);
    await db.exec(readFileSync(join(LOCAL, "app-login.sql"), "utf8"));
  } catch (error) {
    await db.close();
    throw error;
  }
  return { db, close: () => db.close() };
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
