import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type Database } from "../../scripts/db/index.ts";
import { createTestDatabase, openTestDatabase, type TestDatabase } from "./create-test-database.ts";

// S-1F-e (DAN-785): the postgres engine (project `integration-pg`), over the
// databases `pnpm db:migrate` or the CI job `database` migrated. These are
// tests of authority: they ask for { authority: true }, which the in-process engine refuses.

const open: TestDatabase[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
const track = (db: TestDatabase): TestDatabase => (open.push(db), db);

const denied = /permission denied/u;

describe("createTestDatabase on real PostgreSQL", () => {
  it.each([
    ["logs", "ductus_logs_writer"],
    ["legal", "ductus_legal_app"],
    ["main", "ductus_app"],
  ])("%s: %s may not create in public, and reset ends the role", async (name, role) => {
    const db = track(await createTestDatabase(name, { authority: true }));
    expect(db.engine).toBe("postgres");
    await db.exec(`SET ROLE ${role}`);
    expect((await db.query("SELECT current_user AS u")).rows).toEqual([{ u: role }]);
    await expect(db.exec("CREATE TABLE public.authority_probe (v int)")).rejects.toThrow(denied);
    await db.reset();
    const { rows } = await db.query(
      "SELECT current_user AS u, to_regclass('public.authority_probe')::text AS t",
    );
    expect(rows).toEqual([{ u: "ductus", t: null }]);
  });

  it("nothing a test wrote is seen after reset or by the next open", async () => {
    const a = track(await createTestDatabase("legal", { authority: true }));
    await a.exec(`CREATE TABLE public.leftover (v int); INSERT INTO public.leftover VALUES (1);
      CREATE ROLE ductura_leftover_role NOLOGIN; SET ROLE ductus_legal_migrator;`);
    await a.reset();
    const b = track(await createTestDatabase("legal", { authority: true }));
    const probe = `SELECT to_regclass('public.leftover')::text AS t, current_user AS u,
        (SELECT count(*)::int FROM pg_catalog.pg_roles WHERE rolname = 'ductura_leftover_role') AS r`;
    expect((await a.query(probe)).rows).toEqual([{ t: null, u: "ductus", r: 0 }]);
    expect((await b.query(probe)).rows).toEqual([{ t: null, u: "ductus", r: 0 }]);
  });

  it("reset puts back sequences, advisory locks and prepared statements", async () => {
    const a = track(await createTestDatabase("main", { authority: true }));
    const seq =
      "SELECT last_value::text AS v, is_called AS c FROM collaboration.revision_request_seq";
    const before = (await a.query(seq)).rows;
    await a.exec(`SELECT nextval('collaboration.revision_request_seq'), pg_advisory_lock(785785);
      PREPARE ductura_probe_statement AS SELECT 1;`);
    await a.reset();
    expect((await a.query(seq)).rows).toEqual(before);
    await a.exec("PREPARE ductura_probe_statement AS SELECT 1");
    const b = track(await createTestDatabase("main", { authority: true }));
    expect((await b.query("SELECT pg_try_advisory_lock(785785) AS l")).rows).toEqual([{ l: true }]);
  });

  it("overlapping handles share one sequence baseline, in any closing order", async () => {
    const seq =
      "SELECT last_value::text AS v, is_called AS c FROM collaboration.revision_request_seq";
    const first = await createTestDatabase("main", { authority: true });
    const before = (await first.query(seq)).rows;
    await first.exec("SELECT nextval('collaboration.revision_request_seq')");
    const second = await createTestDatabase("main", { authority: true });
    await second.exec("SELECT nextval('collaboration.revision_request_seq')");
    await first.close();
    await second.close();
    const after = track(await createTestDatabase("main", { authority: true }));
    expect((await after.query(seq)).rows).toEqual(before);
  });
});

// Detection on a throwaway database of the local cluster: a test that ends
// its transaction marks the database as committed to, for good.
describe("a test that ends its own transaction", () => {
  const admin = new pg.Client({
    connectionString: "postgres://ductus:ductus-local-only@127.0.0.1:54329/postgres",
  });
  const dir = mkdtempSync(join(tmpdir(), "test-database-commit-"));
  const probe: Database = {
    name: "probe",
    database: `ductura_commit_probe_${process.pid}`,
    migrationsDir: dir,
    ledger: join(dir, "migrations.sum"),
    testsDir: join(dir, "tests"),
    migrator: "ductus",
    service: "postgres-main",
  };
  const url = `postgres://ductus:ductus-local-only@127.0.0.1:54329/${probe.database}`;
  const fresh = async (): Promise<void> => {
    await admin.query(`DROP DATABASE IF EXISTS ${probe.database}`);
    await admin.query(`CREATE DATABASE ${probe.database}`);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query("CREATE TABLE public.schema_migrations (version varchar PRIMARY KEY)");
    await c.end();
  };
  beforeAll(async () => {
    await admin.connect();
  });
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${probe.database}`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    "COMMIT",
    "ROLLBACK",
    "COMMIT; BEGIN",
    "END; BEGIN",
    "COMMIT AND CHAIN",
    "COMMIT; SELECT 1/0",
    "ROLLBACK; CREATE TABLE public.escaped (v int)",
    // Codex review c.4579724002 and c.4579724004.
    "CREATE TABLE public.escaped (v int); COMMIT; BEGIN; SELECT 1/0",
    "CREATE TABLE public.escaped (v int); COMMIT; SET ROLE ductus_app",
    "CREATE TABLE public.escaped (v int); COMMIT; SET SESSION AUTHORIZATION ductus_app",
  ])("fails (%s), and the database is refused from then on", async (end) => {
    await fresh();
    const db = track(await openTestDatabase("probe", "postgres", {}, [probe]));
    await expect(db.exec(`SELECT 1; ${end}`)).rejects.toThrow(/ended its own transaction/u);
    await expect(openTestDatabase("probe", "postgres", {}, [probe])).rejects.toThrow(
      /committed to it/u,
    );
  });

  it("a failed call is undone and the test's transaction goes on", async () => {
    await fresh();
    const db = track(await openTestDatabase("probe", "postgres", {}, [probe]));
    await db.exec("CREATE TABLE public.kept (v int)");
    await expect(db.exec("INSERT INTO public.kept VALUES (1); SELECT 1/0")).rejects.toThrow(
      /division by zero/u,
    );
    expect((await db.query("SELECT count(*)::int AS n FROM public.kept")).rows).toEqual([{ n: 0 }]);
    await db.reset();
    expect((await db.query("SELECT to_regclass('public.kept')::text AS t")).rows).toEqual([
      { t: null },
    ]);
    // Nothing was committed, so the database is not marked.
    const again = track(await openTestDatabase("probe", "postgres", {}, [probe]));
    expect(again.engine).toBe("postgres");
  });

  it("refuses settings sent at connection (PGOPTIONS)", async () => {
    await fresh();
    process.env["PGOPTIONS"] = "-c session_replication_role=replica";
    try {
      await expect(openTestDatabase("probe", "postgres", {}, [probe])).rejects.toThrow(
        /session_replication_role/u,
      );
    } finally {
      delete process.env["PGOPTIONS"];
    }
  });
});
