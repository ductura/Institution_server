import { afterEach, describe, expect, it } from "vitest";

import { DATABASES } from "../../scripts/db/index.ts";
import { openTestDatabase, type TestDatabase } from "./create-test-database.ts";
import { PARITY_EXCEPTIONS } from "./exceptions.ts";
import { catalogFingerprint, compareFingerprints } from "./parity.ts";

// S-1F-e (DAN-785): the same migrations give the same database in PGlite and
// in real PostgreSQL, for every entry of scripts/db/databases.ts. A
// difference is either in exceptions.ts with its reason or a failure here.
// Project `integration-pg`, run in CI by `pnpm test:database`.

const open: TestDatabase[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});

describe("migration parity, PGlite and PostgreSQL", () => {
  it("covers main, logs and legal", () => {
    expect(DATABASES.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["main", "logs", "legal"]),
    );
  });

  it.each(DATABASES.map((entry) => entry.name))(
    "%s: same catalogue in both engines",
    async (name) => {
      const pglite = await openTestDatabase(name, "pglite");
      open.push(pglite);
      const postgres = await openTestDatabase(name, "postgres");
      open.push(postgres);
      expect(pglite.engine).toBe("pglite");
      expect(postgres.engine).toBe("postgres");
      const a = await catalogFingerprint(pglite);
      const b = await catalogFingerprint(postgres);
      expect(a.filter((line) => line.startsWith("migration ")).length).toBeGreaterThan(0);
      const report = compareFingerprints(name, a, b, PARITY_EXCEPTIONS);
      expect(report.unexplained).toEqual([]);
      expect(report.stale).toEqual([]);
    },
    120_000,
  );
});
