import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./create-test-database.ts";

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

  it.each(["COMMIT", "ROLLBACK", "COMMIT; BEGIN", "END; BEGIN"])(
    "a test that ends its own transaction (%s) fails",
    async (end) => {
      const db = track(await createTestDatabase("logs", { authority: true }));
      await expect(db.exec(`SELECT 1; ${end}`)).rejects.toThrow(/ended its own transaction/u);
    },
  );
});
