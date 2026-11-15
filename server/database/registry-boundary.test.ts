// S-1F-a (DAN-783): a connection to a database is opened only through the
// registry. ESLint (`no-restricted-imports`, `database-boundary`) already keeps
// the driver inside server/database; this test keeps the pool and the client
// of the driver inside registry.ts there, with two named exceptions that may
// only ever be removed. Test code (tests/, *.test.ts) owns pools of its own.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** Where a connection may be made. The list may only get shorter. */
const ALLOWED: readonly string[] = [
  "server/database/registry.ts",
  // One client of the migrator that holds the migration lock (S-0.13).
  "server/database/migration-lock.ts",
  // A one-off command run by hand before one migration (S-0.17).
  "server/database/plain-label-check.ts",
];

// Ways to make a pool or a client: `new pg.Pool`, `new Pool` after
// `const { Pool } = pg`, `new pg.native.Client`, `pg["Pool"]`, a pool taken
// apart from the driver, and `.connect(` on the driver itself.
const CONNECTS: readonly RegExp[] = [
  /\bnew\s+[\w$.\s]*?\b(?:Pool|Client)\b/u,
  /\bpg\s*(?:\?\.)?\s*\[/u,
  /\bpg\s*(?:\?\.)?\s*\.\s*native\b/u,
  /\{[^}]*\b(?:Pool|Client)\b[^}]*\}\s*=\s*pg\b/u,
  /\bpg\s*\.\s*connect\s*\(/u,
];

function connectsIn(source: string): boolean {
  return CONNECTS.some((pattern) => pattern.test(source));
}

function productionFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed
    .split("\0")
    .filter((file) => file !== "" && !file.endsWith(".test.ts") && !file.startsWith("tests/"));
}

describe("database connections only through the registry", () => {
  it("finds no other place that makes a pool or a client", () => {
    const offenders = productionFiles().filter(
      (file) => !ALLOWED.includes(file) && connectsIn(readFileSync(resolve(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("makes the one registry of the server only in server/database/index.ts", () => {
    const makers = productionFiles().filter(
      (file) =>
        file !== "server/database/registry.ts" &&
        /\bcreateRegistry\s*\(/u.test(readFileSync(resolve(ROOT, file), "utf8")),
    );
    expect(makers).toEqual(["server/database/index.ts"]);
  });

  it("still finds a connection in each allowed file, so the list stays honest", () => {
    for (const file of ALLOWED) {
      expect(connectsIn(readFileSync(resolve(ROOT, file), "utf8")), file).toBe(true);
    }
  });

  it.each([
    "const pool = new pg.Pool({ connectionString });",
    "const { Pool } = pg; const p = new Pool();",
    "const c = new pg.native.Client();",
    'const P = pg["Pool"];',
    "const { Client: C } = pg;",
    "new  pg . Client(url)",
  ])("recognizes %s", (source) => {
    expect(connectsIn(source)).toBe(true);
  });

  it.each(["registry.pool('main')", "import type pg from 'pg'; type P = pg.Pool;"])(
    "lets %s through",
    (source) => {
      expect(connectsIn(source)).toBe(false);
    },
  );
});
