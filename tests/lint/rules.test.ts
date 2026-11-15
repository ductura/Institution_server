import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Each fixture is linted with the repository's own eslint.config.ts under a
// virtual path, so the file-name rules see the name without the file existing
// and the failing fixtures never sit in the tree that `pnpm lint` checks.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// overrideConfigFile pins the root config, as `-c` does in `pnpm lint`: a nested
// eslint.config.ts cannot replace it for one folder.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});

type Fixture = { file: string; code: string };
type Case = Fixture & { rule: string; messageId?: string };

async function lint({ file, code }: Fixture): Promise<ESLint.LintResult["messages"]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  return result?.messages ?? [];
}

const SRC = "export const a = 1;\n";
const AT = "server/a/b.ts";
const SCRIPT = "scripts/a/b.ts";
const imp = (spec: string): string => `import { x } from "${spec}";\n`;

const BOUNDARY = "local/import-boundary";
const NAMING = "@typescript-eslint/naming-convention";
const RENAMED = "local/renamed-import-name";

const failing: Case[] = [
  // the database driver outside server/database (S-0.17; tests/lint/pg-import-boundary*)
  { file: AT, code: imp("pg"), rule: "no-restricted-imports" },
  {
    file: AT,
    code: 'export async function probe(): Promise<unknown> { return import("pg"); }\n',
    rule: "database-boundary/no-restricted-dynamic-imports",
    messageId: "restrictedPg",
  },
  // the contract fake server outside test code (U8; tests/lint/fake-server-boundary.test.ts)
  {
    file: AT,
    code: imp("../contracts/generated/fake-server/index.ts"),
    rule: "local/no-fake-server-import",
  },
  // area-boundary: areas import each other only as docs/server-map.md §2 allows
  // (S-1A-b; tests/lint/area-boundary.test.ts)
  { file: "server/log/b.ts", code: imp("../database/index.ts"), rule: "local/area-boundary" },
  // no-dynamic-load: loader globals and modules off the allow-list (S-1A-c;
  // tests/lint/dynamic-load.test.ts)
  { file: AT, code: "export const m = process.argv;\n", rule: "local/no-dynamic-load" },
  // no-hardcoded-text: interface text in server code (S-1L.2;
  // tests/lint/hardcoded-text.test.ts)
  { file: AT, code: 'export const m = "Prijava je obavezna.";\n', rule: "local/no-hardcoded-text" },
  // import-boundary: leaving the folder other than through <folder>/index.ts
  ...["./sub/c.ts", "../c.ts", "../sib/c.ts", "./x/../../y/z.ts", "./sub/INDEX.ts"].map((spec) => ({
    file: AT,
    code: imp(spec),
    rule: BOUNDARY,
    messageId: "boundary",
  })),
  { file: AT, code: 'import m = require("../c.ts");\n', rule: BOUNDARY, messageId: "boundary" },
  // forms the resolver reads differently from Node and TypeScript
  ...[
    "./sub\\\\c.ts",
    ".\\\\sub\\\\c.ts",
    "./sub/c.ts#/index.ts",
    "./sub/c.ts?/index.ts",
    "./sub/%69ndex.ts",
    "/abs/sub/c.ts",
    "file:///abs/sub/c.ts",
    // absolute on Windows, flagged whatever OS runs lint
    "D:/x/server/store.ts",
    "d:/x/a.ts",
    "D:\\\\x\\\\a.ts",
    "d:\\\\x\\\\a.ts",
    "\\\\\\\\host\\\\share\\\\a.ts",
    "//host/share/a.ts",
  ].map((spec) => ({ file: AT, code: imp(spec), rule: BOUNDARY, messageId: "form" })),
  {
    file: AT,
    code: 'const m = require("D:/x/server/store.ts");\n',
    rule: BOUNDARY,
    messageId: "form",
  },
  {
    file: AT,
    code: 'const m = await import("D:/x/server/store.ts");\n',
    rule: BOUNDARY,
    messageId: "form",
  },
  { file: AT, code: 'export { x } from "./sub/c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'export * from "../sib/c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'import type { T } from "../c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'type M = typeof import("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: 'import m = require("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: 'const m = await import("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: "const m = await import(`../c.ts`);\n", rule: BOUNDARY },
  { file: AT, code: 'const m = require("../c.ts");\n', rule: BOUNDARY },
  ...["./sub", "./sub/index.js", ".", ".."].map((spec) => ({
    file: AT,
    code: imp(spec),
    rule: BOUNDARY,
    messageId: "extension",
  })),
  {
    file: AT,
    code: 'const p = "./c.ts";\nconst m = await import(p);\n',
    rule: BOUNDARY,
    messageId: "dynamic",
  },
  { file: AT, code: 'const d = "sub";\nconst m = await import(`./${d}/c.ts`);\n', rule: BOUNDARY },
  // inline directives cannot switch the boundary rule off
  { file: AT, code: `// eslint-disable-next-line ${BOUNDARY}\n${imp("../c.ts")}`, rule: BOUNDARY },
  { file: AT, code: `/* eslint-disable */\n${imp("../c.ts")}`, rule: BOUNDARY },
  { file: AT, code: `${imp("../c.ts").trimEnd()} // eslint-disable-line\n`, rule: BOUNDARY },
  // kebab-case file names
  ...["fooBar.ts", "Foo.ts", "foo_bar.ts", "foo--bar.ts", "-foo.ts", "foo-.ts", "Foo.test.ts"].map(
    (name) => ({
      file: `server/${name}`,
      code: SRC,
      rule: "local/kebab-case-filename",
    }),
  ),
  // test suffixes
  ...[
    "x.spec.ts",
    "x.e2e.test.ts",
    "x.unit.test.ts",
    "x.tests.ts",
    "x.integration.ts",
    "x.property.ts",
    "x.pg.test.ts",
    "x.pg.property.test.ts",
    "x.integration.pg.test.ts",
  ].map((name) => ({ file: `server/${name}`, code: SRC, rule: "local/test-file-suffix" })),
  // only .ts
  ...["js", "mjs", "cjs", "jsx", "tsx", "mts", "cts", "TS", "Ts", "Js"].map((ext) => ({
    file: `scripts/x.${ext}`,
    code: SRC,
    rule: "local/only-ts",
  })),
  // naming-convention
  { file: AT, code: "export const my_var = 1;\n", rule: NAMING },
  // snake_case of the database only in server/database and tests/db (S-0.17)
  { file: AT, code: "export const row = { user_id: 1 };\n", rule: NAMING },
  { file: "server/log/b.ts", code: "export const row = { user_id: 1 };\n", rule: NAMING },
  { file: AT, code: "export const keys = { Prezime: 1 };\n", rule: NAMING },
  { file: AT, code: "export function Do_thing(): void {}\n", rule: NAMING },
  { file: AT, code: "export type myType = string;\n", rule: NAMING },
  { file: AT, code: "export const o = { some_key: 1 };\n", rule: NAMING },
  { file: AT, code: "export const f = (Bad_arg: string): string => Bad_arg;\n", rule: NAMING },
  // functions, properties, methods and imports are camelCase only
  { file: AT, code: "export function BadName(): void {}\n", rule: NAMING },
  { file: AT, code: "export function BAD_NAME(): void {}\n", rule: NAMING },
  { file: AT, code: "export const o = { BAD_KEY: 1 };\n", rule: NAMING },
  { file: AT, code: "export const o = { BadKey: 1 };\n", rule: NAMING },
  { file: AT, code: "export type T = { BadKey: string };\n", rule: NAMING },
  { file: AT, code: "export const o = { BadMethod(): void {} };\n", rule: NAMING },
  { file: AT, code: "export class C { BadMethod(): void {} }\n", rule: NAMING },
  { file: AT, code: 'import Bad_import from "fast-check";\n', rule: NAMING },
  { file: AT, code: 'import BadImport from "fast-check";\n', rule: NAMING },
  // a renamed import or export: naming-convention skips named imports (DAN-757)
  ...[
    'import { a as bad_import } from "./c.ts";',
    'import { a as Bad_x } from "./c.ts";',
    'import { a as _b } from "./c.ts";',
    'import { a as b_ } from "./c.ts";',
    'import { a as B__C } from "./c.ts";',
    'import x, { a as bad_b } from "./c.ts";',
    'import type { A as bad_b } from "./c.ts";',
    'import { type A as bad_b } from "./c.ts";',
    'import { default as bad_b } from "./c.ts";',
    'import { "a-b" as bad_b } from "./c.ts";',
    'export { a as bad_b } from "./c.ts";',
    'export type { A as bad_b } from "./c.ts";',
    "const a = 1;\nexport { a as bad_b };",
    'const a = 1;\nexport { a as "bad_b" };',
    'export { "x-y" as bad_b } from "./c.ts";',
    'export * as bad_ns from "./c.ts";',
    'import bad_x = require("./c.ts");',
    "namespace Ns { export const m = 1; }\nimport bad_x = Ns.m;",
    "namespace Ns { export const m = 1; }\nexport import bad_x = Ns.m;",
  ].map((code) => ({ file: SCRIPT, code: `${code}\n`, rule: RENAMED })),
  // the ESTree-name list is exact and covers only object-literal methods
  { file: AT, code: "export function Program(): void {}\n", rule: NAMING },
  { file: AT, code: "export const o = { ProgramX(): void {} };\n", rule: NAMING },
  // the wire-name list is exact and covers only properties
  { file: AT, code: "export const o = { logout_token_x: 1 };\n", rule: NAMING },
  { file: AT, code: "export const o = { x_logout_token: 1 };\n", rule: NAMING },
  { file: AT, code: "export const logout_token = 1;\n", rule: NAMING },
  { file: AT, code: "export type logout_token = string;\n", rule: NAMING },
  // no-explicit-any, type over interface, no enum
  {
    file: AT,
    code: "export const f = (v: any): void => {};\n",
    rule: "@typescript-eslint/no-explicit-any",
  },
  {
    file: AT,
    code: "export interface A { a: string }\n",
    rule: "@typescript-eslint/consistent-type-definitions",
  },
  { file: AT, code: "export enum Color { RED }\n", rule: "no-restricted-syntax" },
  { file: AT, code: "export const enum Color { RED }\n", rule: "no-restricted-syntax" },
];

const passing: Fixture[] = [
  {
    file: "server/database/b.ts",
    code: "export const row = { user_id: 1, statement_timeout: 0 };\n",
  },
  { file: "tests/db/b.integration.test.ts", code: "export const row = { user_id: 1 };\n" },
  { file: "server/log/b.test.ts", code: "export const keys = { Prezime: 1 };\n" },
  ...[
    "./c.ts",
    "./index.ts",
    "./sub/index.ts",
    "../index.ts",
    "../sib/index.ts",
    "./sub/../c.ts",
    "node:fs",
  ].map((spec) => ({ file: AT, code: imp(spec) })),
  // Outside server/: server code may load only its dependencies and no
  // import()/require (local/no-dynamic-load, tests/lint/dynamic-load.test.ts).
  { file: SCRIPT, code: imp("fast-check") },
  { file: AT, code: 'export { x } from "./c.ts";\nexport * from "./sub/index.ts";\n' },
  {
    file: AT,
    code: 'import type { T } from "./sub/index.ts";\ntype M = typeof import("../index.ts");\n',
  },
  { file: SCRIPT, code: 'import m = require("./sub/index.ts");\n' },
  {
    file: SCRIPT,
    code: 'const m = await import("./sub/index.ts");\nconst n = await import(`./c.ts`);\n',
  },
  ...[
    "foo-bar.ts",
    "a1.ts",
    "index.ts",
    "self-test.ts",
    "x.test.ts",
    "x.property.test.ts",
    "x.integration.test.ts",
    "x.pg.integration.test.ts",
  ].map((name) => ({ file: `server/${name}`, code: SRC })),
  { file: "vitest.config.ts", code: SRC },
  // a name kept as another module wrote it, and the allowed aliases (DAN-757)
  ...[
    'import { Type } from "./c.ts";',
    'import { type Server } from "./c.ts";',
    'import type { Server } from "./c.ts";',
    'import { snake_name } from "./c.ts";',
    'import * as ns from "./c.ts";',
    'import x, { snake_name } from "./c.ts";',
    'import { a as b, c as C, d as MAX_D } from "./c.ts";',
    'import { snake_name as snakeName } from "./c.ts";',
    'import { "a-b" as aB } from "./c.ts";',
    'export { snake_name } from "./c.ts";',
    'export { a as default } from "./c.ts";',
    'export { a as b, c as C } from "./c.ts";',
    "const a = 1;\nexport { a as MAX_A };",
    'const a = 1;\nexport { a as "x-y" };',
    'export { snake_name as "snake_name" } from "./c.ts";',
    'export * from "./c.ts";',
    'export * as ns from "./c.ts";',
    'import m = require("./c.ts");',
  ].map((code) => ({ file: SCRIPT, code: `${code}\n` })),
  { file: "test-support/make-user.ts", code: SRC },
  {
    file: AT,
    code: [
      "export const myVar = 1;",
      "export const MAX_SIZE = 2;",
      "export const Schema = { camelKey: 1, 'content-type': 'x' };",
      "export const visitor = { Program(): void {}, CallExpression: (): void => {} };",
      "export type MyType = { a: string };",
      "export function doThing(value: unknown): unknown { return value; }",
      "export const body = { logout_token: 'x' };",
      "export type Body = { logout_token: string };",
      "",
    ].join("\n"),
  },
];

describe("lint rules", () => {
  it.each(failing)("$rule fails: $file · $code", async (fixture) => {
    const messages = await lint(fixture);
    expect(messages.map((m) => m.ruleId)).toContain(fixture.rule);
    if (fixture.messageId) {
      expect(messages.filter((m) => m.ruleId === fixture.rule).map((m) => m.messageId)).toContain(
        fixture.messageId,
      );
    }
  });

  it.each(passing)("passes: $file · $code", async (fixture) => {
    expect(await lint(fixture)).toEqual([]);
  });

  it("every rule in the config has a failing fixture", async () => {
    const config = (await eslint.calculateConfigForFile(path.join(ROOT, AT))) as {
      rules: Record<string, unknown>;
    };
    const covered = new Set(failing.map((c) => c.rule));
    // Rules switched off (eslint-config-prettier) check nothing, so they need no fixture.
    const on = Object.entries(config.rules).filter(([, entry]) => {
      const severity = Array.isArray(entry) ? entry[0] : entry;
      return severity !== 0 && severity !== "off";
    });
    expect(on.length).toBeGreaterThan(0);
    expect(on.map(([rule]) => rule).filter((rule) => !covered.has(rule))).toEqual([]);
  });

  it("an inline directive is itself reported, so --max-warnings 0 fails", async () => {
    const messages = await lint({
      file: AT,
      code: `// eslint-disable-next-line ${BOUNDARY}\n${imp("./c.ts")}`,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBeNull();
  });

  it("has no nested eslint config that could replace the root one", () => {
    const nested = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter(
      (file) =>
        !file.split(path.sep).includes("node_modules") &&
        /(?:^|[\\/])eslint\.config\.[^/\\]+$/.test(file),
    );
    expect(nested).toEqual(["eslint.config.ts"]);
  });

  it("covers every source folder; only tool output is ignored", async () => {
    for (const file of [
      "server/x.ts",
      "scripts/x.ts",
      "test-support/x.ts",
      "locales/x.ts",
      "db/migrations/x.ts",
      "tests/x.test.ts",
      "eslint.config.ts",
    ]) {
      expect(await eslint.isPathIgnored(path.join(ROOT, file)), file).toBe(false);
    }
    for (const file of ["node_modules/p/x.ts", "dist/x.ts", "coverage/x.ts"]) {
      expect(await eslint.isPathIgnored(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
