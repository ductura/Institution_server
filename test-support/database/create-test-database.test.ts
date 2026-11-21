import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Database, DATABASES } from "../../scripts/db/index.ts";
import {
  AUTHORITY_REFUSED,
  engineFrom,
  openTestDatabase,
  pgliteAllowedIn,
  testDatabaseNamed,
} from "./create-test-database.ts";
import { PARITY_EXCEPTIONS } from "./exceptions.ts";
import { compareFingerprints } from "./parity.ts";
import { adminUrl } from "./postgres.ts";

// S-1F-e (DAN-785). Nothing here opens a database.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE = readFileSync(join(ROOT, "compose.yaml"), "utf8");

/** An invented entry whose files do not exist: opening it would fail. */
const PROBE: Database = {
  name: "probe",
  database: "ductura_probe",
  migrationsDir: "test-support/database/no-such-dir/migrations",
  ledger: "test-support/database/no-such-dir/migrations.sum",
  testsDir: "test-support/database/no-such-dir/tests",
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

  it.each([
    ["a/b.pg.integration.test.ts", false],
    ["a/b.PG.Integration.test.ts", false],
    ["a\\.x\\b.pg.integration.test.ts", false],
    ["a/b.integration.test.ts", true],
    ["a/b.test.ts", true],
    ["/r/test-support/database/migration-parity.pg.integration.test.ts", true],
    ["/r/x/migration-parity.pg.integration.test.ts", false],
    ["/r/test-support/database/zz-migration-parity.pg.integration.test.ts", false],
    [undefined, true],
  ] as const)("PGlite from %j: %s", (path, allowed) => {
    expect(pgliteAllowedIn(path)).toBe(allowed);
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
  it("runs *.pg.integration.test.ts only in integration-pg, on postgres", () => {
    expect(CONFIG).toContain("const PG = `${DIRS}/**/*.pg.integration.test.ts`;");
    expect(project("integration-pg")).toMatch(/^name: "integration-pg",\n\s+include: \[PG\],/u);
    expect(project("integration-pg")).toContain('env: { DUCTURA_TEST_DATABASE: "postgres" }');
    expect(project("integration-pg")).toContain('setupFiles: ["tests/db/setup.ts"]');
    expect(project("integration")).toMatch(/exclude: \[DATABASE, PG\],/u);
    expect(project("integration")).toContain('env: { DUCTURA_TEST_DATABASE: "pglite" }');
    expect(project("database")).toMatch(/exclude: \[PG\],/u);
    // The unit project also leaves out the copied tests that wait for their task (ZEL-S4).
    expect(project("unit")).toMatch(/exclude: \[PROPERTY, INTEGRATION, \.\.\.PENDING_TESTS\],/u);
    // Only integration-pg names postgres; the PG glob is included nowhere else.
    expect(CONFIG.match(/DUCTURA_TEST_DATABASE: "postgres"/gu)).toHaveLength(1);
    expect(CONFIG.match(/include: \[[^\]]*\bPG\b/gu)).toHaveLength(1);
  });

  it("package.json runs integration-pg from test:database, which CI runs", () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["test:integration:pg"]).toBe("vitest run --project integration-pg");
    expect(scripts["test:database"]).toBe(
      "vitest run --project database && pnpm test:integration:pg",
    );
    // CI runs the same two vitest runs, each split by the matrix leg.
    expect(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")).toMatch(
      /run: \|\n {10}pnpm exec vitest run --project database --shard="\$SHARD"\n {10}pnpm test:integration:pg --shard="\$SHARD"\n/u,
    );
  });
});

describe("tests of authority", () => {
  // Every folder vitest's DIRS glob reaches, dot folders included.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.pg\.integration\.test\.ts$/iu.test(name)) files.push(relative(ROOT, path));
    }
  };
  for (const dir of [
    "server",
    "packages",
    "test-support",
    "tests",
    "scripts",
    "infra",
    "db",
    "locales",
  ])
    walk(join(ROOT, dir));

  it("exist, and none names PGlite or the test fakes, in any spelling", () => {
    expect(files.length).toBeGreaterThan(0);
    const naming = files.filter((file) =>
      /pglite|test-fakes/iu.test(readFileSync(join(ROOT, file), "utf8")),
    );
    // The parity test compares both engines on purpose and asks for no authority.
    expect(naming).toEqual(["test-support/database/migration-parity.pg.integration.test.ts"]);
  });
});

describe("adminUrl", () => {
  it("takes the local superuser and port of the entry's compose service", () => {
    const url = (name: string) => new URL(adminUrl(testDatabaseNamed(name, DATABASES), COMPOSE));
    expect([url("main").port, url("main").pathname]).toEqual(["54329", "/ductus"]);
    expect([url("logs").port, url("logs").pathname]).toEqual(["54330", "/ductus_logs"]);
    expect([url("legal").port, url("legal").pathname]).toEqual(["54329", "/ductus_legal"]);
  });

  it.each([
    ["a public port", 'services:\n  postgres-main:\n    ports: ["0.0.0.0:54329:5432"]\n'],
    [
      "a foreign port",
      'services:\n  postgres-main:\n    ports: ["127.0.0.1:6543:5432"]\n    environment: { POSTGRES_USER: u, POSTGRES_PASSWORD: p }\n',
    ],
    ["no superuser", 'services:\n  postgres-main:\n    ports: ["127.0.0.1:54329:5432"]\n'],
    ["no service", "services: {}\n"],
  ])("refuses %s", (_case, compose) => {
    expect(() => adminUrl(PROBE, compose)).toThrow(/probe|postgres-main/u);
  });
});

describe("compareFingerprints", () => {
  const entry = { database: "main", only: "pglite", line: "b", reason: "x" } as const;

  it("lists lines one engine lacks and exceptions that no longer differ", () => {
    expect(compareFingerprints("main", ["a", "b"], ["a", "c"], [])).toEqual({
      unexplained: ["pglite only: b", "postgres only: c"],
      stale: [],
    });
    expect(compareFingerprints("main", ["a", "b"], ["a"], [entry])).toEqual({
      unexplained: [],
      stale: [],
    });
    expect(compareFingerprints("main", ["a"], ["a"], [entry])).toEqual({
      unexplained: [],
      stale: [entry],
    });
    // An exception of another database or the other engine explains nothing.
    expect(compareFingerprints("logs", ["a", "b"], ["a"], [entry]).unexplained).toEqual([
      "pglite only: b",
    ]);
    expect(compareFingerprints("main", ["a"], ["a", "b"], [entry]).unexplained).toEqual([
      "postgres only: b",
    ]);
  });

  it("every exception names a database, an engine, a line and a reason", () => {
    for (const exception of PARITY_EXCEPTIONS) {
      expect(DATABASES.map((d) => d.name)).toContain(exception.database);
      expect(["pglite", "postgres"]).toContain(exception.only);
      expect(exception.line).not.toBe("");
      expect(exception.reason.length).toBeGreaterThan(10);
    }
  });
});
