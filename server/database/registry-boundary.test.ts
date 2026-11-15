// S-1F-a (DAN-783): a connection to a database is opened only through the
// registry. ESLint (`no-restricted-imports`, `database-boundary`) already keeps
// the driver inside server/database; this test keeps every runtime use of the
// driver inside registry.ts there, with two named exceptions that may only
// ever be removed. Elsewhere the driver may be imported only as a type, so
// neither `new pg.Pool`, `new (pg.Pool)`, a renamed `Pool` nor
// `Reflect.construct(pg.Pool, …)` can be written. The second registry is kept
// out too: only server/database/index.ts makes one. Test code (tests/,
// *.test.ts) owns pools of its own, and the tools in scripts/ and db/ are no
// part of the server.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PG_SPECIFIER } from "../../scripts/lint-rules/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DRIVER = new RegExp(PG_SPECIFIER, "iu");

/** Where the driver may be used at runtime. The list may only get shorter. */
const ALLOWED: readonly string[] = [
  "server/database/registry.ts",
  // One client of the migrator that holds the migration lock (S-0.13).
  "server/database/migration-lock.ts",
  // A one-off command run by hand before one migration (S-0.17).
  "server/database/plain-label-check.ts",
];
/** Where a registry may be made or named. */
const REGISTRY_MAKERS: readonly string[] = [
  "server/database/registry.ts",
  "server/database/index.ts",
];

const isDriver = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && DRIVER.test(node.text.trim());

// An import or export of the driver that stays at runtime: anything but
// `import type`, `export type` or an import whose every name is a type.
function typeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // import "pg" runs the module
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

// require, module.require, import(), and a call of a call (createRequire(…)(…)).
const isLoader = (callee: ts.Expression): boolean =>
  callee.kind === ts.SyntaxKind.ImportKeyword ||
  (ts.isIdentifier(callee) && callee.text === "require") ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === "require") ||
  ts.isCallExpression(callee);

/** The runtime uses of the driver in `source`, as short descriptions. */
function runtimeDriverUses(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isDriver(node.moduleSpecifier) && !typeOnly(node)) {
      found.push("import");
    } else if (ts.isExportDeclaration(node) && isDriver(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push("export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isDriver(node.moduleReference.expression)
    ) {
      found.push("import =");
    } else if (
      ts.isCallExpression(node) &&
      isLoader(node.expression) &&
      isDriver(node.arguments[0])
    ) {
      found.push("load");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function productionFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed
    .split("\0")
    .filter((file) => file.startsWith("server/") && !file.endsWith(".test.ts"));
}
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

describe("database connections only through the registry", () => {
  it("finds the driver at runtime nowhere else", () => {
    const offenders = productionFiles()
      .filter((file) => !ALLOWED.includes(file))
      .flatMap((file) => runtimeDriverUses(read(file)).map((use) => `${file}: ${use}`));
    expect(offenders).toEqual([]);
  });

  it("makes or names the registry only in server/database", () => {
    const makers = productionFiles().filter(
      (file) => !REGISTRY_MAKERS.includes(file) && /\bcreateRegistry\b/u.test(read(file)),
    );
    expect(makers).toEqual([]);
  });

  it("still finds the driver in each allowed file, so the list stays honest", () => {
    for (const file of ALLOWED) expect(runtimeDriverUses(read(file)), file).not.toEqual([]);
  });

  it.each([
    'import pg from "pg"; const p = new (pg.Pool)({});',
    'import { Pool as Bucket } from "pg"; new Bucket({});',
    'import pg from "pg"; Reflect.construct(pg.Pool, [{}]);',
    'import * as driver from "pg";',
    'import "pg";',
    'import Pool from "pg-pool";',
    'import { type Pool, Client } from "pg";',
    'export { Pool } from "pg";',
    'import pg = require("pg");',
    'const pg = require(" pg");',
    'const pg = await import("pg/lib/index.js");',
    'const pg = createRequire(import.meta.url)("pg");',
  ])("recognizes %s", (source) => {
    expect(runtimeDriverUses(source)).not.toEqual([]);
  });

  it.each([
    'import type pg from "pg";',
    'import type { Pool } from "pg";',
    'import { type Pool, type QueryConfig } from "pg";',
    'export type { Pool } from "pg";',
    'import { registry } from "./pg-like.ts";',
    'run("psql", ["-d", "postgres"]);',
  ])("lets %s through", (source) => {
    expect(runtimeDriverUses(source)).toEqual([]);
  });
});
