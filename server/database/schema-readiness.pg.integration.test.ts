// SRV-1812 against the migrated PostgreSQL of `pnpm db:up` or the CI job
// `database` (project integration-pg), over the local-only application login
// of db/main/local/app-login.sql, no secret. The application role reads the
// catalogue only: migrated with no lock, pending while another session holds
// the lock of the migration runner, and the ledger stays closed to it.
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createSchemaReadinessReader, MIGRATION_LOCK_KEY } from "./schema-readiness.ts";
import { createWithActor } from "./with-actor.ts";

const URL_OF_MAIN =
  process.env.APP_DATABASE_URL ??
  "postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:54329/ductus";

const pool = new pg.Pool({ connectionString: URL_OF_MAIN, max: 2 });
const read = createSchemaReadinessReader(createWithActor(pool), 2_000);

afterAll(async () => {
  await pool.end();
});

describe("schema readiness on the migrated main database", () => {
  it("is migrated when no migration run holds the lock", async () => {
    await expect(read()).resolves.toEqual({ migrated: true });
  });

  it("is pending while another session holds the migration lock, and migrated after", async () => {
    const holder = new pg.Client({ connectionString: URL_OF_MAIN });
    await holder.connect();
    try {
      await holder.query("SELECT pg_catalog.pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      await expect(read()).resolves.toEqual({ migrated: false, reason: "migrating" });
      await holder.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
      await expect(read()).resolves.toEqual({ migrated: true });
    } finally {
      await holder.end();
    }
  });

  it("does not need the ledger, which the application role still cannot read", async () => {
    const client = await pool.connect();
    try {
      await expect(client.query("SELECT version FROM public.schema_migrations")).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
