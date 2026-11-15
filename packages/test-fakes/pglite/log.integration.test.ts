import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createFakeLogDatabase, type FakeLogDatabase } from "./log.ts";

// U9-b (DAN-741): the fake log database is append-only for everyone.

const open: FakeLogDatabase[] = [];
afterEach(async () => {
  for (const log of open.splice(0)) await log.close();
});

async function seeded(): Promise<FakeLogDatabase> {
  const log = await createFakeLogDatabase();
  open.push(log);
  await log.append("login", { account: "demo-student-1" });
  await log.append("logout", { account: "demo-student-1", reason: "user" });
  return log;
}

const CHANGES = [
  "UPDATE logs.entry SET kind = 'changed'",
  "UPDATE logs.entry SET payload = '{}'::jsonb WHERE id = 1",
  "DELETE FROM logs.entry",
  "DELETE FROM logs.entry WHERE id = 2",
  "TRUNCATE logs.entry",
];

const AS = {
  writer: "SET LOCAL ROLE fake_logs_writer;",
  owner: "SET LOCAL ROLE fake_logs_owner;",
  superuser: "",
  "superuser with session_replication_role = replica":
    "SET LOCAL session_replication_role = replica;",
};

describe("createFakeLogDatabase", () => {
  it("appends and returns every entry in order, unchanged", async () => {
    const log = await seeded();
    const entries = await log.entries();
    expect(entries.map(({ id, kind, payload }) => ({ id, kind, payload }))).toEqual([
      { id: 1, kind: "login", payload: { account: "demo-student-1" } },
      { id: 2, kind: "logout", payload: { account: "demo-student-1", reason: "user" } },
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
    "ALTER TABLE logs.entry DISABLE TRIGGER entry_no_change",
    "DROP TRIGGER entry_no_truncate ON logs.entry",
    "DROP TABLE logs.entry",
  ])("the writer cannot remove the protection: %s", async (sql) => {
    const log = await seeded();
    await expect(
      log.db.exec(`BEGIN; SET LOCAL ROLE fake_logs_writer; ${sql}; COMMIT;`),
    ).rejects.toThrow(/must be owner|permission denied|no privileges/u);
    await log.db.exec("ROLLBACK");
  });

  it.each([
    "INSERT INTO logs.entry (id, kind, payload) OVERRIDING SYSTEM VALUE VALUES (-5, 'x', '{}')",
    "INSERT INTO logs.entry (at, kind, payload) VALUES ('1999-01-01', 'x', '{}')",
  ])("the writer cannot forge the order: %s", async (sql) => {
    const log = await seeded();
    const before = await log.entries();
    await expect(
      log.db.exec(`BEGIN; SET LOCAL ROLE fake_logs_writer; ${sql}; COMMIT;`),
    ).rejects.toThrow(/permission denied/u);
    await log.db.exec("ROLLBACK");
    expect(await log.entries()).toEqual(before);
  });

  it("a GRANT by the writer gives it nothing", async () => {
    const log = await seeded();
    await log.db.exec(
      "BEGIN; SET LOCAL ROLE fake_logs_writer; GRANT UPDATE, DELETE, TRUNCATE ON logs.entry TO fake_logs_writer; COMMIT;",
    );
    const rights = await log.db.query<{ u: boolean; d: boolean; t: boolean }>(
      `SELECT has_table_privilege('fake_logs_writer', 'logs.entry', 'UPDATE') AS u,
              has_table_privilege('fake_logs_writer', 'logs.entry', 'DELETE') AS d,
              has_table_privilege('fake_logs_writer', 'logs.entry', 'TRUNCATE') AS t`,
    );
    expect(rights.rows).toEqual([{ u: false, d: false, t: false }]);
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
