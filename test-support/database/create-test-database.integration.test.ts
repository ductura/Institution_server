import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Database, DATABASES, readMigrations, renderLedger } from "../../scripts/db/index.ts";
import { createTestDatabase, openTestDatabase, type TestDatabase } from "./create-test-database.ts";
import { catalogFingerprint } from "./parity.ts";

// S-1F-e (DAN-785): the PGlite engine (project `integration`).

const open: TestDatabase[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const track = (db: TestDatabase): TestDatabase => (open.push(db), db);

describe("createTestDatabase on PGlite", () => {
  it.each(DATABASES.map((entry) => [entry.name, entry] as const))(
    "%s: every migration, in the database of its production name",
    async (name, entry) => {
      const db = track(await createTestDatabase(name));
      expect(db.engine).toBe("pglite");
      const { rows } = await db.query<{ d: string; versions: string[] }>(
        "SELECT current_database() AS d, array_agg(version ORDER BY version) AS versions FROM public.schema_migrations",
      );
      const files = readdirSync(entry.migrationsDir).map((file) => file.split("_")[0]);
      expect(rows).toEqual([{ d: entry.database, versions: files.sort() }]);
    },
    60_000,
  );

  it("reset and a second open see nothing of what a test did", async () => {
    const a = track(await createTestDatabase("main"));
    const b = track(await createTestDatabase("main"));
    const clean = await catalogFingerprint(a);
    await a.exec(`CREATE TABLE public.leftover (v int); INSERT INTO public.leftover VALUES (1);
      CREATE ROLE leftover_role; ALTER ROLE ductus_app SET work_mem = '1MB';
      SET ROLE ductus_migrator;`);
    const probe = `SELECT to_regclass('public.leftover')::text AS t,
        (SELECT count(*)::int FROM pg_catalog.pg_roles WHERE rolname = 'leftover_role') AS r,
        (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting) AS s, current_user AS u`;
    const before = (await b.query(probe)).rows;
    expect(before).toEqual([{ t: null, r: 0, s: before[0]?.["s"], u: "postgres" }]);
    expect((await a.query(probe)).rows[0]?.["t"]).toBe("leftover");
    await a.reset();
    expect((await a.query(probe)).rows).toEqual(before);
    expect(await catalogFingerprint(a)).toEqual(clean);
  }, 60_000);

  it("the fingerprint sees a policy, a grant and a security definer", async () => {
    const db = track(await createTestDatabase("main"));
    const clean = await catalogFingerprint(db);
    expect(clean.some((line) => line.startsWith("policy "))).toBe(true);
    expect(clean.some((line) => / secdef=true /u.test(line))).toBe(true);
    for (const change of [
      "ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;",
      "GRANT USAGE ON SCHEMA public TO PUBLIC;",
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';",
      // Blind spots the adversarial pass found (DAN-785).
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ductus_app;",
      "GRANT ductus_evidence TO ductus_app;",
      "ALTER ROLE ductus_app BYPASSRLS;",
      "ALTER ROLE ductus_app SET row_security = off;",
      "ALTER SEQUENCE collaboration.revision_request_seq INCREMENT BY 2;",
      "CREATE DOMAIN public.d AS int CHECK (VALUE > 0);",
      "CREATE VIEW public.v AS SELECT 1 AS x; ALTER VIEW public.v SET (security_barrier);",
    ]) {
      // Cumulative, one database: each change must still move the fingerprint
      // on top of the ones before it. Reopening a copy per change kept four
      // CI cores busy next to load-sensitive tests (#71, mutation-request).
      const before = await catalogFingerprint(db);
      await db.exec(change);
      expect(await catalogFingerprint(db), change).not.toEqual(before);
    }
  }, 60_000);

  it("a new entry in the list gets its database without code", async () => {
    const root = mkdtempSync(join(tmpdir(), "test-database-probe-"));
    temps.push(root);
    const migrations = join(root, "probe", "migrations");
    mkdirSync(migrations, { recursive: true });
    mkdirSync(join(root, "probe", "local"));
    writeFileSync(
      join(root, "probe", "local", "migrator.sql"),
      `CREATE ROLE probe_migrator NOLOGIN;
       ALTER DATABASE ductura_probe OWNER TO probe_migrator;
       GRANT CREATE ON SCHEMA public TO probe_migrator;`,
    );
    writeFileSync(
      join(migrations, "29990101000000_probe.sql"),
      "-- migrate:up\nCREATE TABLE public.probe (v int);\n-- migrate:down\n",
    );
    writeFileSync(join(root, "probe", "migrations.sum"), renderLedger(readMigrations(migrations)));
    const probe: Database = {
      name: "probe",
      database: "ductura_probe",
      migrationsDir: migrations,
      ledger: join(root, "probe", "migrations.sum"),
      testsDir: join(root, "probe", "tests"),
      migrator: "probe_migrator",
      service: "postgres-main",
    };
    const db = track(await openTestDatabase("probe", "pglite", {}, [probe]));
    const { rows } = await db.query(
      "SELECT current_database() AS d, pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class WHERE relname = 'probe'",
    );
    expect(rows).toEqual([{ d: "ductura_probe", owner: "probe_migrator" }]);
  }, 60_000);
});
