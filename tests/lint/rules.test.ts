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
const imp = (spec: string): string => `import { x } from "${spec}";\n`;

const BOUNDARY = "local/import-boundary";
const NAMING = "@typescript-eslint/naming-convention";

const failing: Case[] = [
  // import-boundary: leaving the folder other than through <folder>/index.ts
  ...["./sub/c.ts", "../c.ts", "../sib/c.ts", "./x/../../y/z.ts", "./sub/INDEX.ts"].map((spec) => ({
    file: AT, code: imp(spec), rule: BOUNDARY, messageId: "boundary",
  })),
  { file: AT, code: 'import m = require("../c.ts");\n', rule: BOUNDARY, messageId: "boundary" },
  // forms the resolver reads differently from Node and TypeScript
  ...[
    "./sub\\\\c.ts", ".\\\\sub\\\\c.ts", "./sub/c.ts#/index.ts", "./sub/c.ts?/index.ts", "./sub/%69ndex.ts",
    "/abs/sub/c.ts", "file:///abs/sub/c.ts",
  ].map((spec) => ({ file: AT, code: imp(spec), rule: BOUNDARY, messageId: "form" })),
  { file: AT, code: 'export { x } from "./sub/c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'export * from "../sib/c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'import type { T } from "../c.ts";\n', rule: BOUNDARY },
  { file: AT, code: 'type M = typeof import("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: 'import m = require("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: 'const m = await import("../c.ts");\n', rule: BOUNDARY },
  { file: AT, code: "const m = await import(`../c.ts`);\n", rule: BOUNDARY },
  { file: AT, code: 'const m = require("../c.ts");\n', rule: BOUNDARY },
  ...["./sub", "./sub/index.js", ".", ".."].map((spec) => ({
    file: AT, code: imp(spec), rule: BOUNDARY, messageId: "extension",
  })),
  { file: AT, code: 'const p = "./c.ts";\nconst m = await import(p);\n', rule: BOUNDARY, messageId: "dynamic" },
  { file: AT, code: 'const d = "sub";\nconst m = await import(`./${d}/c.ts`);\n', rule: BOUNDARY },
  // inline directives cannot switch the boundary rule off
  { file: AT, code: `// eslint-disable-next-line ${BOUNDARY}\n${imp("../c.ts")}`, rule: BOUNDARY },
  { file: AT, code: `/* eslint-disable */\n${imp("../c.ts")}`, rule: BOUNDARY },
  { file: AT, code: `${imp("../c.ts").trimEnd()} // eslint-disable-line\n`, rule: BOUNDARY },
  // kebab-case file names
  ...["fooBar.ts", "Foo.ts", "foo_bar.ts", "foo--bar.ts", "-foo.ts", "foo-.ts", "Foo.test.ts"].map((name) => ({
    file: `server/${name}`, code: SRC, rule: "local/kebab-case-filename",
  })),
  // test suffixes
  ...["x.spec.ts", "x.e2e.test.ts", "x.unit.test.ts", "x.tests.ts", "x.integration.ts", "x.property.ts"]
    .map((name) => ({ file: `server/${name}`, code: SRC, rule: "local/test-file-suffix" })),
  // only .ts
  ...["js", "mjs", "cjs", "jsx", "tsx", "mts", "cts", "TS", "Ts", "Js"].map((ext) => ({
    file: `scripts/x.${ext}`, code: SRC, rule: "local/only-ts",
  })),
  // naming-convention
  { file: AT, code: "export const my_var = 1;\n", rule: NAMING },
  { file: AT, code: "export function Do_thing(): void {}\n", rule: NAMING },
  { file: AT, code: "export type myType = string;\n", rule: NAMING },
  { file: AT, code: "export const o = { some_key: 1 };\n", rule: NAMING },
  { file: AT, code: "export const f = (Bad_arg: string): string => Bad_arg;\n", rule: NAMING },
  // the wire-name list is exact and covers only properties
  { file: AT, code: "export const o = { logout_token_x: 1 };\n", rule: NAMING },
  { file: AT, code: "export const o = { x_logout_token: 1 };\n", rule: NAMING },
  { file: AT, code: "export const logout_token = 1;\n", rule: NAMING },
  { file: AT, code: "export type logout_token = string;\n", rule: NAMING },
  // no-explicit-any, type over interface, no enum
  { file: AT, code: "export const f = (v: any): void => {};\n", rule: "@typescript-eslint/no-explicit-any" },
  { file: AT, code: "export interface A { a: string }\n", rule: "@typescript-eslint/consistent-type-definitions" },
  { file: AT, code: "export enum Color { RED }\n", rule: "no-restricted-syntax" },
  { file: AT, code: "export const enum Color { RED }\n", rule: "no-restricted-syntax" },
];

const passing: Fixture[] = [
  ...[
    "./c.ts", "./index.ts", "./sub/index.ts", "../index.ts", "../sib/index.ts", "./sub/../c.ts",
    "node:fs", "fast-check",
  ].map((spec) => ({ file: AT, code: imp(spec) })),
  { file: AT, code: 'export { x } from "./c.ts";\nexport * from "./sub/index.ts";\n' },
  { file: AT, code: 'import type { T } from "./sub/index.ts";\ntype M = typeof import("../index.ts");\n' },
  { file: AT, code: 'import m = require("./sub/index.ts");\n' },
  { file: AT, code: 'const m = await import("./sub/index.ts");\nconst n = await import(`./c.ts`);\n' },
  ...[
    "foo-bar.ts", "a1.ts", "index.ts", "self-test.ts", "x.test.ts", "x.property.test.ts", "x.integration.test.ts",
  ].map((name) => ({ file: `server/${name}`, code: SRC })),
  { file: "vitest.config.ts", code: SRC },
  { file: "test-support/make-user.ts", code: SRC },
  {
    file: AT,
    code: [
      "export const myVar = 1;",
      "export const MAX_SIZE = 2;",
      "export const Schema = { camelKey: 1, UPPER_KEY: 2, 'content-type': 'x' };",
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
      expect(messages.filter((m) => m.ruleId === fixture.rule).map((m) => m.messageId)).toContain(fixture.messageId);
    }
  });

  it.each(passing)("passes: $file · $code", async (fixture) => {
    expect(await lint(fixture)).toEqual([]);
  });

  it("every rule in the config has a failing fixture", async () => {
    const config = (await eslint.calculateConfigForFile(path.join(ROOT, AT))) as { rules: Record<string, unknown> };
    const covered = new Set(failing.map((c) => c.rule));
    expect(Object.keys(config.rules).filter((rule) => !covered.has(rule))).toEqual([]);
  });

  it("an inline directive is itself reported, so --max-warnings 0 fails", async () => {
    const messages = await lint({ file: AT, code: `// eslint-disable-next-line ${BOUNDARY}\n${imp("./c.ts")}` });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBeNull();
  });

  it("has no nested eslint config that could replace the root one", () => {
    const nested = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter(
      (file) => !file.split(path.sep).includes("node_modules") && /(?:^|[\\/])eslint\.config\.[^/\\]+$/.test(file),
    );
    expect(nested).toEqual(["eslint.config.ts"]);
  });

  it("covers every source folder; only tool output is ignored", async () => {
    for (const file of [
      "server/x.ts", "scripts/x.ts", "test-support/x.ts", "locales/x.ts", "db/migrations/x.ts", "tests/x.test.ts",
      "eslint.config.ts",
    ]) {
      expect(await eslint.isPathIgnored(path.join(ROOT, file)), file).toBe(false);
    }
    for (const file of ["node_modules/p/x.ts", "dist/x.ts", "coverage/x.ts"]) {
      expect(await eslint.isPathIgnored(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
