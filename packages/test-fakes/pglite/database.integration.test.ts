import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createFromSource,
  createPgliteDatabase,
  MAIN_SOURCE,
  upSection,
  type PgliteDatabase,
} from "./database.ts";

// U9-b (DAN-741). Negative cases work on a copy in a temporary directory; the
// repository's db/main/migrations and migrations.sum are never touched.

const open: PgliteDatabase[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const track = (db: PgliteDatabase): PgliteDatabase => (open.push(db), db);

const MIGRATIONS = readdirSync(MAIN_SOURCE.dir).sort();
const LAST = MIGRATIONS.at(-1) as string;

/** A copy of the main migrations and ledger; `edit` changes it before use. */
function copy(edit: (dir: string, ledger: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pglite-migrations-"));
  temps.push(root);
  const source = { dir: join(root, "migrations"), ledger: join(root, "migrations.sum") };
  cpSync(MAIN_SOURCE.dir, source.dir, { recursive: true });
  cpSync(MAIN_SOURCE.ledger, source.ledger);
  edit(source.dir, source.ledger);
  return source;
}

/** Rewrites the ledger line of `name` to match new bytes, so only the SQL is wrong. */
async function rewriteLedger(ledger: string, dir: string): Promise<void> {
  const { readMigrations, renderLedger } = await import("../../../scripts/db/index.ts");
  writeFileSync(ledger, renderLedger(readMigrations(dir)));
}

describe("createPgliteDatabase", () => {
  it("applies every main migration as ductus_migrator", async () => {
    const { db } = track(await createPgliteDatabase({ database: "main" }));
    const applied = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.schema_migrations",
    );
    expect(applied.rows[0]?.n).toBe(MIGRATIONS.length);
    const user = await db.query<{ u: string }>("SELECT current_user AS u");
    expect(user.rows[0]?.u).not.toBe("ductus_migrator");
    const owners = await db.query<{ owner: string }>(
      `SELECT DISTINCT pg_catalog.pg_get_userbyid(c.relowner) AS owner
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    );
    // Some migrations hand a table to another group role; none is the superuser's.
    expect(owners.rows.map((row) => row.owner)).toContain("ductus_migrator");
    expect(owners.rows.map((row) => row.owner)).not.toContain("postgres");
    const login = await db.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ductus_app_local'",
    );
    expect(login.rows).toHaveLength(1);
  }, 60_000);

  it("gives every call its own database", async () => {
    const a = track(await createPgliteDatabase());
    const b = track(await createPgliteDatabase());
    await a.db.exec(
      "CREATE TABLE public.isolation_probe (v int); INSERT INTO public.isolation_probe VALUES (1);",
    );
    const seen = await b.db.query("SELECT to_regclass('public.isolation_probe') AS t");
    expect(seen.rows).toEqual([{ t: null }]);
  }, 60_000);

  it.each(["logs", "legal", "x"])("refuses database %j without migrations", async (database) => {
    await expect(
      createPgliteDatabase({ database } as unknown as { database: "main" }),
    ).rejects.toThrow(/no migrations/u);
  });
});

describe("migration source", () => {
  it("refuses a migration that does not match the ledger and applies nothing", async () => {
    const source = copy((dir) => writeFileSync(join(dir, LAST), "-- migrate:up\nSELECT 1;\n"));
    await expect(createFromSource(source)).rejects.toThrow(
      new RegExp(`${LAST}: hash in .* does not match`, "u"),
    );
  });

  it("refuses a missing ledger and a migration the ledger does not list", async () => {
    await expect(createFromSource(copy((_dir, ledger) => rmSync(ledger)))).rejects.toThrow(
      /missing/u,
    );
    const extra = copy((dir) =>
      writeFileSync(join(dir, "29991231000000_extra.sql"), "-- migrate:up\n"),
    );
    await expect(createFromSource(extra)).rejects.toThrow(/is not in/u);
  });

  it("names the migration that fails and rolls it back", async () => {
    const source = copy((dir) =>
      writeFileSync(
        join(dir, "29991231000000_broken.sql"),
        "-- migrate:up\nCREATE TABLE public.half_done (v int);\nSELECT no_such_function();\n-- migrate:down\n",
      ),
    );
    await rewriteLedger(source.ledger, source.dir);
    await expect(createFromSource(source)).rejects.toThrow(
      /^29991231000000_broken\.sql: .*no_such_function/u,
    );
  }, 60_000);

  it("leaves nothing of the failed migration and stops before the next", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE ductus_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT CREATE ON SCHEMA public TO ductus_migrator;
        CREATE TABLE public.schema_migrations (version varchar(128) PRIMARY KEY);
        GRANT INSERT ON public.schema_migrations TO ductus_migrator;`);
      const migration = (version: string, up: string) => ({
        name: `${version}_m.sql`,
        version,
        up,
      });
      await expect(
        applyMigrations(db, [
          migration("1", "CREATE TABLE public.first (v int);"),
          migration("2", "CREATE TABLE public.half_done (v int); SELECT no_such_function();"),
          migration("3", "CREATE TABLE public.never (v int);"),
        ]),
      ).rejects.toThrow(/^2_m\.sql: /u);
      const state = await db.query(
        `SELECT to_regclass('public.first')::text AS first, to_regclass('public.half_done')::text AS half,
                to_regclass('public.never')::text AS never,
                (SELECT array_agg(version ORDER BY version) FROM public.schema_migrations) AS versions,
                pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE relname = 'first')) AS owner`,
      );
      expect(state.rows).toEqual([
        { first: "first", half: null, never: null, versions: ["1"], owner: "ductus_migrator" },
      ]);
    } finally {
      await db.close();
    }
  });

  it("refuses a file without the up marker or with a dbmate option", () => {
    expect(() => upSection("a.sql", "CREATE TABLE t ();")).toThrow(/no "-- migrate:up"/u);
    expect(() => upSection("a.sql", "-- migrate:up transaction:false\nSELECT 1;")).toThrow(
      /unsupported dbmate option/u,
    );
    expect(upSection("a.sql", "-- migrate:up\nSELECT 1;\n-- migrate:down\nDROP x;")).not.toMatch(
      /DROP/u,
    );
  });

  it("reads the markers only at the start of a line, as dbmate", () => {
    const up = upSection(
      "a.sql",
      "-- migrate:up\nCREATE TABLE a ();\n  -- dropped in -- migrate:down\nCREATE TABLE b ();\n-- migrate:down\nDROP x;",
    );
    expect(up).toMatch(/CREATE TABLE b/u);
    expect(up).not.toMatch(/DROP/u);
    expect(() => upSection("a.sql", "SELECT 1; -- migrate:up\nSELECT 2;")).toThrow(
      /no "-- migrate:up"/u,
    );
  });

  it.each([
    ["COMMIT", "CREATE TABLE public.c1 (v int); COMMIT;", /ends its own transaction/u],
    ["RESET ROLE", "RESET ROLE; CREATE TABLE public.r1 (v int);", /ran as the superuser/u],
    ["RESET ROLE", "RESET ROLE; CREATE ROLE evil SUPERUSER;", /ran as the superuser/u],
  ])("refuses a migration that leaves the migrator role (%s)", async (_what, up, message) => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE ductus_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT CREATE ON SCHEMA public TO ductus_migrator;
        CREATE TABLE public.schema_migrations (version varchar(128) PRIMARY KEY);
        GRANT INSERT ON public.schema_migrations TO ductus_migrator;`);
      await applyMigrations(db, [{ name: "1_m.sql", version: "1", up: "SELECT 1; RESET ROLE;" }]);
      await expect(applyMigrations(db, [{ name: "2_m.sql", version: "2", up }])).rejects.toThrow(
        message,
      );
      const applied = await db.query("SELECT version FROM public.schema_migrations");
      expect(applied.rows).toEqual([{ version: "1" }]);
    } finally {
      await db.close();
    }
  });

  it("refuses a file name dbmate would not read as a version", async () => {
    const source = copy((dir) => writeFileSync(join(dir, "extra.sql"), "-- migrate:up\n"));
    await rewriteLedger(source.ledger, source.dir);
    await expect(createFromSource(source)).rejects.toThrow(/extra\.sql: not/u);
  });
});
