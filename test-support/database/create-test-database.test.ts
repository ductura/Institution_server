import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Database, DATABASES } from "../../scripts/db/index.ts";
import {
  AUTHORITY_REFUSED,
  engineFrom,
  openTestDatabase,
  POSTGRES_NOT_YET,
  testDatabaseNamed,
} from "./create-test-database.ts";

// S-1F-e (DAN-785). Nothing here opens a database.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** An invented entry whose files do not exist: opening it would fail. */
const PROBE: Database = {
  name: "probe",
  database: "ductura_probe",
  migrationsDir: "test-support/database/no-such-dir/migrations",
  ledger: "test-support/database/no-such-dir/migrations.sum",
  migrator: "ductura_probe_migrator",
  service: "postgres-main",
};

describe("engineFrom", () => {
  it.each([
    [undefined, "pglite"],
    ["pglite", "pglite"],
    ["postgres", "postgres"],
  ] as const)("%j is %s", (value, engine) => {
    expect(engineFrom({ DUCTURA_TEST_DATABASE: value })).toBe(engine);
  });

  it.each(["", "Postgres", "pg", "postgres "])("refuses %j", (value) => {
    expect(() => engineFrom({ DUCTURA_TEST_DATABASE: value })).toThrow(/must be/u);
  });
});

describe("testDatabaseNamed", () => {
  it("finds every database of scripts/db/databases.ts and a new entry without code", () => {
    for (const entry of DATABASES) expect(testDatabaseNamed(entry.name, DATABASES)).toBe(entry);
    expect(testDatabaseNamed("probe", [...DATABASES, PROBE])).toBe(PROBE);
  });

  it.each(["x", "", "MAIN", "constructor", "__proto__"])("refuses unknown %j", (name) => {
    expect(() => testDatabaseNamed(name, DATABASES)).toThrow(/unknown database/u);
  });
});

describe("a test of authority", () => {
  it("is refused on PGlite before anything opens", async () => {
    // The probe's files do not exist, so any other error would mean it opened.
    await expect(openTestDatabase("probe", "pglite", { authority: true }, [PROBE])).rejects.toThrow(
      AUTHORITY_REFUSED,
    );
  });

  it("the postgres engine is not here yet (DAN-785 b)", async () => {
    await expect(openTestDatabase("main", "postgres", { authority: true })).rejects.toThrow(
      POSTGRES_NOT_YET,
    );
  });

  it("an unknown name is refused first, on either engine", async () => {
    for (const engine of ["pglite", "postgres"] as const)
      await expect(openTestDatabase("x", engine, { authority: true })).rejects.toThrow(
        /unknown database/u,
      );
  });
});

// Read as text, as scripts/ci/workflow.test.ts does: another folder is
// imported only through its index.ts.
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
/** The text of the vitest project called `name`, up to the next project. */
const project = (name: string): string => {
  const start = CONFIG.indexOf(`name: "${name}",`);
  if (start < 0) throw new Error(`no project ${name}`);
  const end = CONFIG.indexOf("name: ", start + 6);
  return CONFIG.slice(start, end < 0 ? undefined : end);
};

describe("vitest.config.ts", () => {
  it("keeps *.pg.integration.test.ts out of the PGlite projects", () => {
    expect(CONFIG).toContain("const PG = `${DIRS}/**/*.pg.integration.test.ts`;");
    expect(project("integration")).toMatch(/exclude: \[DATABASE, PG\],/u);
    expect(project("integration")).toContain('env: { DUCTURA_TEST_DATABASE: "pglite" }');
    expect(project("database")).toMatch(/exclude: \[PG\],/u);
    expect(project("unit")).toMatch(/exclude: \[PROPERTY, INTEGRATION\],/u);
    // No project runs the postgres engine or includes the PG glob yet (DAN-785 b).
    expect(CONFIG).not.toMatch(/DUCTURA_TEST_DATABASE: "postgres"/u);
    expect(CONFIG).not.toMatch(/include: \[[^\]]*\bPG\b/u);
  });
});

describe("tests of authority", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".pg.integration.test.ts")) files.push(relative(ROOT, path));
    }
  };
  for (const dir of ["server", "packages", "test-support", "tests", "scripts", "infra", "db"])
    walk(join(ROOT, dir));

  it("none names PGlite", () => {
    const naming = files.filter((file) =>
      /@electric-sql\/pglite|test-fakes\/pglite|["']pglite["']/u.test(
        readFileSync(join(ROOT, file), "utf8"),
      ),
    );
    expect(naming).toEqual([]);
  });
});
