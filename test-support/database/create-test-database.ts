import { migratedDump, openDump, sourceOf } from "@ductura/test-fakes/pglite";
import { expect } from "vitest";

import { type Database, DATABASES } from "../../scripts/db/index.ts";
import { openPostgresDatabase } from "./postgres.ts";

// S-1F-e (DAN-785): every database of scripts/db/databases.ts has a fake for
// tests, built from the same migrations. A new database is a new entry there
// (name, migrations, ledger, local/migrator.sql); nothing here changes.
//
// Two engines, picked by the vitest project (vitest.config.ts):
// - pglite, project `integration` (`pnpm test:integration`): in process, a
//   fresh copy of the migrated database per open and per reset;
// - postgres, project `integration-pg` (`pnpm test:integration:pg`): the
//   migrated local or CI database, each test in one transaction rolled back.
// PGlite is no proof of privileges, RLS or SECURITY DEFINER (S-0.3), so a test
// of authority runs only on postgres: its file is *.pg.integration.test.ts and
// it asks with { authority: true }, which PGlite refuses before opening.

export type TestDatabaseEngine = "pglite" | "postgres";

export type TestDatabase = {
  readonly name: string;
  readonly engine: TestDatabaseEngine;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  /** Back to the state right after the migrations. */
  reset(): Promise<void>;
  close(): Promise<void>;
};

export type TestDatabaseOptions = { readonly authority?: boolean };

export const ENGINE_VARIABLE = "DUCTURA_TEST_DATABASE";

/** The engine the environment names; unset is pglite, anything else is an error. */
export function engineFrom(env: Readonly<Record<string, string | undefined>>): TestDatabaseEngine {
  const value = env[ENGINE_VARIABLE];
  if (value === undefined || value === "pglite") return "pglite";
  if (value === "postgres") return "postgres";
  throw new Error(`${ENGINE_VARIABLE} must be "pglite" or "postgres"`);
}

// Read once: a test that changes the variable later does not change the engine.
const ENGINE = engineFrom(process.env);

export const AUTHORITY_REFUSED = "authority test needs real PostgreSQL (pnpm test:integration:pg)";

export const PG_FILE_REFUSED = "a *.pg.integration.test.ts file runs only on real PostgreSQL";

const PG_FILE = /\.pg\.integration\.test\.ts$/iu;

// The one file of integration-pg that opens PGlite on purpose: it compares engines.
const PARITY_FILE = "test-support/database/migration-parity.pg.integration.test.ts";

/**
 * Whether a test in `testPath` may open PGlite: never from a test of
 * authority's file, whatever the environment says (adversarial pass, DAN-785),
 * except the parity test.
 */
export function pgliteAllowedIn(testPath: string | undefined): boolean {
  if (testPath === undefined) return true;
  const path = testPath.replaceAll("\\", "/");
  return !PG_FILE.test(path) || path.endsWith(`/${PARITY_FILE}`);
}

/** The entry called `name` of `databases`; unknown is an error, never a default. */
export function testDatabaseNamed(name: string, databases: readonly Database[]): Database {
  const found = databases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(
      `unknown database "${name}"; one of: ${databases.map((entry) => entry.name).join(", ")}`,
    );
  }
  return found;
}

// One migration run per database and process; every open copies the dump.
const dumps = new Map<string, Promise<Blob>>();

function dumpOf(target: Database): Promise<Blob> {
  const key = `${target.name}\0${target.migrationsDir}\0${target.ledger}`;
  let dump = dumps.get(key);
  if (dump === undefined) {
    dump = migratedDump(sourceOf(target), target);
    dumps.set(key, dump);
    // A failed run is not kept, so the next test sees the error again.
    dump.catch(() => dumps.delete(key));
  }
  return dump;
}

async function openPglite(target: Database): Promise<TestDatabase> {
  const dump = await dumpOf(target);
  let db = await openDump(dump, target.database);
  return {
    name: target.name,
    engine: "pglite",
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: (await db.query<T>(sql, params)).rows,
    }),
    exec: async (sql) => {
      await db.exec(sql);
    },
    reset: async () => {
      await db.close();
      db = await openDump(dump, target.database);
    },
    close: () => db.close(),
  };
}

/** A test database of `name` on `engine`; `createTestDatabase` takes the project's engine. */
export async function openTestDatabase(
  name: string,
  engine: TestDatabaseEngine,
  options: TestDatabaseOptions = {},
  databases: readonly Database[] = DATABASES,
): Promise<TestDatabase> {
  const target = testDatabaseNamed(name, databases);
  if (options.authority === true && engine !== "postgres") throw new Error(AUTHORITY_REFUSED);
  if (engine === "pglite" && !pgliteAllowedIn(expect.getState().testPath))
    throw new Error(PG_FILE_REFUSED);
  return engine === "pglite" ? openPglite(target) : openPostgresDatabase(target);
}

/** A test database of `name` on the engine of the running vitest project. */
export function createTestDatabase(
  name: string,
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  return openTestDatabase(name, ENGINE, options);
}
