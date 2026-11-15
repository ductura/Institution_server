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

async function checkMigrated(client: pg.Client, target: Database): Promise<void> {
  const files = readdirSync(resolve(ROOT, target.migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.split("_")[0])
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

/** The migrated database of `target`, one transaction per test. */
export async function openPostgresDatabase(target: Database): Promise<TestDatabase> {
  const client = new pg.Client({
    connectionString: adminUrl(target, readFileSync(resolve(ROOT, "compose.yaml"), "utf8")),
    application_name: `ductura-test-${target.name}`,
  });
  await client.connect();
  let xid = "";
  const begin = async (): Promise<void> => {
    await client.query("BEGIN");
    xid = (await client.query<{ x: string }>("SELECT pg_catalog.txid_current()::text AS x")).rows[0]
      ?.x as string;
  };
  // A COMMIT or ROLLBACK inside the test's SQL would let it outlive the test.
  const sameTransaction = async (): Promise<void> => {
    const now = await client.query<{ x: string }>("SELECT pg_catalog.txid_current()::text AS x");
    if (now.rows[0]?.x !== xid) throw new Error("the test ended its own transaction");
  };
  try {
    let check = checked.get(target.name);
    if (check === undefined) {
      check = checkMigrated(client, target);
      checked.set(target.name, check);
    }
    await check;
    await begin();
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    name: target.name,
    engine: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      await sameTransaction();
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await client.query(sql);
      await sameTransaction();
    },
    reset: async () => {
      await client.query("ROLLBACK");
      await begin();
    },
    close: async () => {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}
