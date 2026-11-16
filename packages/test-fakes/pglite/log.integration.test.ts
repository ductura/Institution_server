import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFakeLogDatabase, type FakeLogDatabase } from "./log.ts";

// U9-b (DAN-741), S-1K.2-a (DAN-813): the fake log database, the migrated
// logs database, is append-only for everyone.

// The logs database is migrated once per process (log.ts); that first run
// gets the 60 s budget of the other PGlite migration tests, so no test below
// pays it inside the 5 s test timeout.
beforeAll(async () => {
  await (await createFakeLogDatabase()).close();
}, 60_000);

const open: FakeLogDatabase[] = [];
afterEach(async () => {
  for (const log of open.splice(0)) await log.close();
});

async function seeded(): Promise<FakeLogDatabase> {
  const log = await createFakeLogDatabase();
  open.push(log);
  await log.append("authn.login_succeeded", { account: "demo-student-1" });
  await log.append("session.logged_out", { account: "demo-student-1", reason: "user" });
  return log;
}

const CHANGES = [
  "UPDATE public.log_entry SET kind = 'authn.changed'",
  "UPDATE public.log_entry SET payload = '{}'::jsonb WHERE id = 1",
  "DELETE FROM public.log_entry",
  "DELETE FROM public.log_entry WHERE id = 2",
  "TRUNCATE public.log_entry",
];

const AS = {
  writer: "SET LOCAL ROLE ductus_logs_writer;",
  reader: "SET LOCAL ROLE ductus_logs_reader;",
  retention: "SET LOCAL ROLE ductus_logs_retention;",
  owner: "SET LOCAL ROLE ductus_logs_migrator;",
  superuser: "",
  "superuser with session_replication_role = replica":
    "SET LOCAL session_replication_role = replica;",
};

describe("createFakeLogDatabase", () => {
  it("appends and returns every entry in order, unchanged", async () => {
    const log = await seeded();
    const entries = await log.entries();
    expect(entries.map(({ id, kind, payload }) => ({ id, kind, payload }))).toEqual([
      { id: 1, kind: "authn.login_succeeded", payload: { account: "demo-student-1" } },
      { id: 2, kind: "session.logged_out", payload: { account: "demo-student-1", reason: "user" } },
    ]);
    expect(entries[0]?.at).toBeInstanceOf(Date);
  });

  it.each(Object.entries(AS).flatMap(([who, set]) => CHANGES.map((sql) => [who, set, sql])))(
    "as %s refuses %s and the entries stay",
    async (_who, set, sql) => {
      const log = await seeded();
      const before = await log.entries();
      await expect(log.db.exec(`BEGIN; ${set} ${sql}; COMMIT;`)).rejects.toThrow(
        /append-only|permission denied/u,
      );
      await log.db.exec("ROLLBACK");
      expect(await log.entries()).toEqual(before);
    },
  );

  it.each([
    "ALTER TABLE public.log_entry DISABLE TRIGGER log_entry_no_change",
    "DROP TRIGGER log_entry_no_truncate ON public.log_entry",
    "DROP TABLE public.log_entry",
  ])("the writer cannot remove the protection: %s", async (sql) => {
    const log = await seeded();
    await expect(
      log.db.exec(`BEGIN; SET LOCAL ROLE ductus_logs_writer; ${sql}; COMMIT;`),
    ).rejects.toThrow(/must be owner|permission denied|no privileges/u);
    await log.db.exec("ROLLBACK");
  });

  it.each([
    "INSERT INTO public.log_entry (id, kind, payload) OVERRIDING SYSTEM VALUE VALUES (-5, 'x', '{}')",
    "INSERT INTO public.log_entry (at, kind, payload) VALUES ('1999-01-01', 'x', '{}')",
  ])("the writer cannot forge the order: %s", async (sql) => {
    const log = await seeded();
    const before = await log.entries();
    await expect(
      log.db.exec(`BEGIN; SET LOCAL ROLE ductus_logs_writer; ${sql}; COMMIT;`),
    ).rejects.toThrow(/permission denied/u);
    await log.db.exec("ROLLBACK");
    expect(await log.entries()).toEqual(before);
  });

  it("a GRANT by the writer gives it nothing", async () => {
    const log = await seeded();
    // The writer holds no right on the table as a whole, so PostgreSQL refuses
    // the GRANT outright (with a table right it would only warn).
    await expect(
      log.db.exec(
        "BEGIN; SET LOCAL ROLE ductus_logs_writer; GRANT UPDATE, DELETE, TRUNCATE ON public.log_entry TO ductus_logs_writer; COMMIT;",
      ),
    ).rejects.toThrow(/permission denied/u);
    await log.db.exec("ROLLBACK");
    const rights = await log.db.query<{ u: boolean; d: boolean; t: boolean }>(
      `SELECT has_table_privilege('ductus_logs_writer', 'public.log_entry', 'UPDATE') AS u,
              has_table_privilege('ductus_logs_writer', 'public.log_entry', 'DELETE') AS d,
              has_table_privilege('ductus_logs_writer', 'public.log_entry', 'TRUNCATE') AS t`,
    );
    expect(rights.rows).toEqual([{ u: false, d: false, t: false }]);
  });

  it.each([
    ["ductus_logs_writer", "SELECT count(*) FROM public.log_entry"],
    ["ductus_logs_retention", "SELECT count(*) FROM public.log_entry"],
    ["ductus_logs_reader", "INSERT INTO public.log_entry (kind, payload) VALUES ('authn.x', '{}')"],
  ])("%s is refused: %s", async (role, sql) => {
    const log = await seeded();
    await expect(log.db.exec(`BEGIN; SET LOCAL ROLE ${role}; ${sql}; COMMIT;`)).rejects.toThrow(
      /permission denied/u,
    );
    await log.db.exec("ROLLBACK");
    expect(await log.entries()).toHaveLength(2);
  });

  it("is the logs database with its migrations, the log table among them", async () => {
    const log = await seeded();
    const result = await log.db.query<{ db: string; version: string }>(
      "SELECT current_database() AS db, version FROM public.schema_migrations WHERE version = '20261116160000'",
    );
    expect(result.rows).toEqual([{ db: "ductus_logs", version: "20261116160000" }]);
  });

  it("append returns the row it appended, not the one with the largest id", async () => {
    const log = await createFakeLogDatabase();
    open.push(log);
    await log.db.exec(
      `INSERT INTO public.log_entry (id, kind, payload) OVERRIDING SYSTEM VALUE
         VALUES (1000, 'authn.login_started', '{"planted": true}')`,
    );
    const entry = await log.append("session.logged_out", { reason: "user" });
    expect(entry.id).not.toBe(1000);
    expect({ kind: entry.kind, payload: entry.payload }).toEqual({
      kind: "session.logged_out",
      payload: { reason: "user" },
    });
  });

  it("refuses a payload that is not JSON and an empty kind", async () => {
    const log = await seeded();
    await expect(log.append("x", undefined)).rejects.toThrow(TypeError);
    await expect(log.append("", {})).rejects.toThrow(/check constraint/u);
    expect(await log.entries()).toHaveLength(2);
  });

  it("gives every call its own database", async () => {
    const a = await seeded();
    const b = await createFakeLogDatabase();
    open.push(b);
    expect(await b.entries()).toEqual([]);
    expect(await a.entries()).toHaveLength(2);
  });

  // S-1F-c (DAN-779) brought db/logs/migrations with roles only; the fake
  // stands in for the log table, so it has to go once a migration of the log
  // database creates a table (S-1F-b/S-1F-e).
  it("the temporary schema is gone once a migration of the log database creates a table (S-1F)", () => {
    const schema = fileURLToPath(new URL("./log-schema.sql", import.meta.url));
    const dir = fileURLToPath(new URL("../../../db/logs/migrations", import.meta.url));
    const tables = existsSync(dir)
      ? readdirSync(dir).filter((name) =>
          /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/iu.test(readFileSync(join(dir, name), "utf8")),
        )
      : [];
    expect(existsSync(schema) && tables.length > 0).toBe(false);
  });
});
