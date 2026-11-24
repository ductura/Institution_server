import { afterEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./create-test-database.ts";
import { exclusive, settled } from "./postgres.ts";

// ZEL-SRV-PG-TESTNA-VEZA: one connection serves a whole handle, so calls made
// side by side take turns. Without them, the savepoints of two calls nest, a
// failed call rolls back its neighbour's work, and a RESET ROLE of one turn
// lands before another's query.

const open: TestDatabase[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
const opened = async (): Promise<TestDatabase> => {
  const db = await createTestDatabase("main", { authority: true });
  open.push(db);
  return db;
};

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

it("runs calls made side by side one at a time, a failed one alone rolled back", async () => {
  const db = await opened();
  await db.exec("CREATE TEMPORARY TABLE turn_probe (v int PRIMARY KEY)");
  const calls = await Promise.allSettled([
    db.exec("INSERT INTO turn_probe VALUES (1)"),
    db.query("SELECT 1 / 0"),
    db.exec("INSERT INTO turn_probe VALUES (2)"),
    db.exec("INSERT INTO turn_probe VALUES (2)"),
    db.query("INSERT INTO turn_probe VALUES (3) RETURNING v"),
  ]);
  expect(calls.map(({ status }) => status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  const { rows } = await db.query("SELECT v FROM turn_probe ORDER BY v");
  expect(rows).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
});

it("keeps a turn's role to its own calls while other calls wait", async () => {
  const db = await opened();
  const role = (): Promise<unknown> =>
    exclusive(db, async () => {
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        await pause();
        return (await db.query("SELECT current_user AS u")).rows;
      } finally {
        await db.exec("RESET ROLE");
      }
    });
  const [first, outside, second] = await Promise.all([
    role(),
    db.query("SELECT current_user AS u"),
    role(),
  ]);
  expect(first).toEqual([{ u: "ductus_app" }]);
  expect(second).toEqual([{ u: "ductus_app" }]);
  expect(outside.rows).toEqual([{ u: "ductus" }]);
});

it("runs a turn inside a turn as part of it, and settles turns queued meanwhile", async () => {
  const db = await opened();
  const order: string[] = [];
  const first = exclusive(db, async () => {
    await pause();
    order.push("first");
    // Inside its own turn: run now, not queued behind it (which would never end).
    return exclusive(db, async () => (await db.query("SELECT 1 AS one")).rows);
  });
  const settling = settled(db);
  // Queued after settled() began: it waits for this turn as well.
  void exclusive(db, async () => {
    await pause();
    order.push("later");
  });
  await settling;
  expect(order).toEqual(["first", "later"]);
  expect(await first).toEqual([{ one: 1 }]);
});
