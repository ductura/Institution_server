import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  DYNAMIC_LOAD_ALLOWED,
  IMPORT_META,
  KEY_LITERAL_ALLOWED,
  TEST_ONLY_RE,
} from "../../scripts/lint-rules/index.ts";

// S-1A-c (DAN-770): server code loads modules only by a static import, through
// an allow-list (contract Ductus#1836 c.6891713609). The fixtures cover every
// bypass of the two review FAILs on ductura/server#37 (c.6888904929,
// c.6889015219) and are linted under virtual paths with the repository config.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});
const RULE = "local/no-dynamic-load";

async function ids(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.messageId ?? "");
}

type Case = { file: string; code: string; messageId: string };
const LOG = "server/log/x.ts";
const ENV = "server/config/environment.ts";
const at = (file: string, messageId: string, codes: string[]): Case[] =>
  codes.map((code) => ({ file, code, messageId }));
// Every form of a static import that loads (or re-exports) a module.
const importForms = (spec: string): string[] => [
  `import { x } from "${spec}";\n`,
  `import * as m from "${spec}";\n`,
  `import d from "${spec}";\n`,
  `import "${spec}";\n`,
  `import { type X } from "${spec}";\n`,
  `export { x } from "${spec}";\n`,
  `export * from "${spec}";\n`,
];

const failing: Case[] = [
  // FAIL c.6888904929: process under another name, destructured loaders.
  {
    file: LOG,
    code: [
      'import { getBuiltinModule } from "node:process";',
      'const { createRequire: cr } = getBuiltinModule("module");',
      'export const db = cr(import.meta.url)("../database/index.ts");',
    ].join("\n"),
    messageId: "module",
  },
  ...at(LOG, "module", ['import { getBuiltinModule as g } from "node:process";\n']),
  ...at(LOG, "global", [
    'const { getBuiltinModule } = process;\nexport const m = getBuiltinModule("fs");\n',
    'const { getBuiltinModule } = globalThis.process;\nexport const m = getBuiltinModule("fs");\n',
    'export const m = globalThis["process"];\n',
  ]),
  // FAIL c.6889015219: an alias and a key in a template.
  ...[LOG, "server/domain/x.ts", ENV].flatMap((file) =>
    at(file, "global", [
      'const p = process;\nexport const fs = p[`getBuiltinModule`]("fs");\n',
      'export const fs = process[`getBuiltinModule`]("fs");\n',
      'export const fs = process["getBuiltinModule"]("fs");\n',
      'const k = "getBuiltinModule";\nexport const fs = process[k]("fs");\n',
    ]),
  ),
  // A tab (or other spelling) in a specifier: matching is exact.
  ...["node:\tmodule", "node:\tprocess", " node:fs", "node:fs ", "node:Module", "NODE:fs"].flatMap(
    (spec) => at(LOG, "module", [`import { x } from "${spec}";\n`]),
  ),
  // A longer name than load.ts, and the same content in any other file.
  ...[
    "server/domain/forensics/golden-vectors/load.ts-extra.ts",
    "server/domain/forensics/golden-vectors/load2.ts",
    "server/domain/forensics/golden-vectors/Load.ts",
    "server/domain/forensics/load.ts",
  ].flatMap((file) =>
    at(file, "global", ['export const u = new URL("./x.json", import.meta.url);\n']),
  ),
  // The allow-list holds only the exact file: environment.ts content elsewhere fails.
  ...[
    "server/config/environment2.ts",
    "server/config/environment.ts-extra.ts",
    "server/config/Environment.ts",
    "server/log/environment.ts",
    "server/config/sub/environment.ts",
  ].flatMap((file) =>
    at(file, "global", ["export function f(env = process.env): unknown {\n  return env;\n}\n"]),
  ),
  // In a listed file, every form other than name.<listed member>.
  ...at(ENV, "global", [
    "const p = process;\nexport const e = p.env;\n",
    "const { env } = process;\nexport const e = env;\n",
    "export const b = process.getBuiltinModule;\n",
    "export const m = process.mainModule;\n",
    "export const m = process.binding;\n",
    "export const p = process.platform;\n",
    "export const c = globalThis.crypto;\n",
    "export const p = globalThis.process.env;\n",
    "export const f = (g: (x: unknown) => void): void => g(process);\n",
    "export { process };\n",
    "export const t = typeof process;\n",
  ]),
  ...at("server/database/plain-label-check.ts", "global", [
    'export const r = import.meta.resolve("node:fs");\n',
    "const m = import.meta;\nexport const u = m.url;\n",
    'export const u = import.meta["url"];\n',
  ]),
  // Loader globals and dynamic import, anywhere.
  ...[LOG, ENV, "server/test-server/x.ts", "server/x.ts"].flatMap((file) => [
    ...at(file, "dynamicImport", [
      'export const m = await import("node:fs");\n',
      "export const m = await import(`./y.ts`);\n",
      "export const load = (s: string): Promise<unknown> => import(s);\n",
    ]),
    ...at(file, "importRequire", ['import m = require("./y.ts");\nexport { m };\n']),
    ...at(file, "global", [
      'export const m = require("node:fs");\n',
      'export const m = module.require("node:fs");\n',
      'export const v = eval("1");\n',
      'export const v = (0, eval)("1");\n',
      'export const f = Function("return 1");\n',
      'export const f = new Function("return 1");\n',
      "export const p = global.process;\n",
      "export const e = exports;\n",
      'declare const require: (s: string) => unknown;\nexport const m = require("node:fs");\n',
      "declare global {\n  var process: { x: number };\n}\nexport const p = process.x;\n",
      'declare function eval(s: string): unknown;\nexport const v = eval("1");\n',
    ]),
  ]),
  // The DAN-770 list, with node: and without, in every static form; then the
  // other loaders the allow-list keeps out.
  ...["module", "process", "vm", "worker_threads", "child_process", "cluster"].flatMap((name) =>
    [name, `node:${name}`].flatMap((spec) => at(LOG, "module", importForms(spec))),
  ),
  ...[
    "node:inspector",
    "node:inspector/promises",
    "repl",
    "node:test",
    "tsx/esm/api",
    "vitest",
    "fs",
    "node:fs/../module",
    "pg/../tsx",
    "pg/./lib",
    "@sinclair/typebox-x",
    "../../node_modules/tsx/dist/esm/api/index.ts",
    "../../scripts/index.ts",
    "../node_modules/x/index.ts",
    "data:text/javascript,export default 1",
    "file:///app/server/database/index.ts",
    "/app/server/database/index.ts",
  ].flatMap((spec) => at(LOG, "module", importForms(spec))),
  // The Function constructor through `constructor`, and node:crypto's native
  // engine loader, in every static spelling (attack pass on this PR).
  ...at(LOG, "key", [
    "export const F = (async () => 1).constructor;\n",
    'export const F = (() => 1)["constructor"];\n',
    "export const F = (() => 1)[`constructor`];\n",
    "const { constructor: F } = () => 1;\nexport { F };\n",
    'const { "constructor": F } = () => 1;\nexport { F };\n',
    "export const F = Object.getPrototypeOf(async function () {}).constructor;\n",
    'export const F = Reflect.get(Object.getPrototypeOf(() => 0), "constructor");\n',
    'export const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "constructor");\n',
    // Decision c.6892342579: any literal or template piece containing the key.
    'export const s = "xconstructorx";\n',
    "export const f = (x: string): string => `a${x}constructor`;\n",
    'export const s = "setEngineX";\n',
    // Review FAIL c.6892337734: a forbidden literal inside a non-static `+`.
    'export function load(suffix = ""): unknown {\n  return Reflect.get(() => 0, "constructor" + suffix);\n}\n',
    'export const f = (s: string): unknown => Reflect.get(() => 0, s + "constructor");\n',
    "export const f = (s: string): unknown => (() => 0)[`constructor${s}`];\n",
    'const k = "constructor";\nexport const F = Reflect.get(() => 1, k);\n',
    'import { setEngine } from "node:crypto";\nexport const s = setEngine;\n',
    'import { setEngine as s } from "node:crypto";\nexport { s };\n',
    'import * as c from "node:crypto";\nexport const s = c.setEngine;\n',
    'import * as c from "node:crypto";\nconst { setEngine } = c;\nexport { setEngine };\n',
    'export { setEngine } from "node:crypto";\n',
  ]),
  // The literal is allowed only in the file that holds it as data.
  ...at("server/domain/document/edit-step2.ts", "key", [
    'export const keys = new Set(["__proto__", "constructor", "prototype"]);\n',
  ]),
  // In that file the literal is allowed only as an array element (Codex P2 on #45).
  ...at("server/domain/document/edit-step.ts", "key", [
    `export const fs = (() => 0)["constructor"]("return 1")();\n`,
    'export const F = Reflect.get(() => 0, "constructor");\n',
    'const k = "constructor";\nexport const F = Reflect.get(() => 0, k);\n',
    'const { "constructor": F } = () => 0;\nexport { F };\n',
    // Review FAIL c.6892186063: a spread array literal straight into a loader.
    'export const load = Reflect.get(() => 0, ...(["constructor"] as const));\n',
    'export const F = Reflect.get(() => 0, ["constructor"][0]);\n',
    'export const OTHER = new Set(["constructor"]);\n',
    'export const FORBIDDEN_KEYS = new Set(["constructor"], ["constructor"]);\n',
    'function f(): void {\n  const FORBIDDEN_KEYS = new Set(["constructor"]);\n  void FORBIDDEN_KEYS;\n}\nexport { f };\n',
    'let FORBIDDEN_KEYS = new Set(["constructor"]);\nFORBIDDEN_KEYS = new Set();\nexport { FORBIDDEN_KEYS };\n',
    'class Set {\n  constructor(a: string[]) {\n    void a;\n  }\n}\nconst FORBIDDEN_KEYS = new Set(["constructor"]);\nexport { FORBIDDEN_KEYS };\n',
    'const FORBIDDEN_KEYS = new Set([...["constructor"]]);\nexport { FORBIDDEN_KEYS };\n',
  ]),
];

const passing: Case[] = [
  ...at(ENV, "", [
    "export function f(env = process.env): unknown {\n  return env;\n}\n",
    "export const p = process.env.PORT ?? process.env?.HOST;\n",
  ]),
  ...at("server/external/storage/s3-evidence-payload-store.ts", "", [
    "export const f = globalThis.fetch;\nexport const e = process.env.NODE_ENV;\n",
  ]),
  ...at("server/domain/forensics/evidence-receipt-verifier.ts", "", [
    'export const ok = typeof globalThis.atob === "function" && !!globalThis.crypto?.subtle;\n',
  ]),
  ...at("server/domain/document/edit-step.ts", "", [
    'const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);\nexport const has = (k: string): boolean => FORBIDDEN_KEYS.has(k);\n',
  ]),
  ...at(LOG, "", [
    'export const s = `constr${String(1)}`;\nexport const t = "construct" + "ion";\n',
  ]),
  ...at("server/domain/forensics/golden-vectors/load.ts", "", [
    'export const u = new URL("./x.json", import.meta.url);\n',
  ]),
  ...at(LOG, "", [
    "export function f(process: { env: string }): string {\n  return process.env;\n}\n",
    "export function g(Function: number): number {\n  return Function;\n}\n",
    "export type P = typeof process;\nexport type G = typeof globalThis.process;\n",
    'import type { Context } from "node:vm";\nexport type C = Context;\n',
    'export type { Worker } from "node:worker_threads";\n',
    'export type M = typeof import("node:module");\n',
    'import { y } from "./y.ts";\nexport const z = y;\n',
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    'import { readFile } from "node:fs/promises";\nexport const r = readFile;\n',
    'import { Value } from "@sinclair/typebox/value";\nexport const v = Value;\n',
    'import { Type } from "@sinclair/typebox";\nexport const t = Type;\n',
    "export class X {\n  constructor() {}\n}\n",
    "export const o = { constructor: 1 };\n",
  ]),
];

describe("local/no-dynamic-load (DAN-770)", () => {
  it.each(failing)("$file fails as $messageId: $code", async ({ file, code, messageId }) => {
    expect(await ids(file, code)).toContain(messageId);
  });

  it.each(passing)("$file passes: $code", async ({ file, code }) => {
    expect(await ids(file, code)).toEqual([]);
  });

  it("does not lint test files, and production code cannot import one", async () => {
    expect(
      await ids("server/log/x.test.ts", 'export const m = await import("node:fs");\n'),
    ).toEqual([]);
    const [result] = await eslint.lintText('import { x } from "./y.test.ts";\nexport { x };\n', {
      filePath: LOG,
    });
    expect(result?.messages.map((m) => `${m.ruleId ?? ""}:${m.messageId ?? ""}`)).toContain(
      "local/no-fake-server-import:testCode",
    );
  });
});

// Files in server/ that are neither code nor tests: data and documentation.
const DATA_EXTENSIONS = new Set([".md", ".json", ".txt"]);

describe("the rule covers the whole of server/", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "server"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  it("lints every production file and leaves out only test files that production cannot import", async () => {
    const production: string[] = [];
    const tests: string[] = [];
    for (const file of tracked) {
      if (file.endsWith(".test.ts")) tests.push(file);
      else if (file.endsWith(".ts")) production.push(file);
      else expect(DATA_EXTENSIONS, file).toContain(path.extname(file));
    }
    expect(production.length).toBeGreaterThan(100);
    expect(tests.length).toBeGreaterThan(50);
    const severity = async (file: string): Promise<unknown> => {
      const config = (await eslint.calculateConfigForFile(path.join(ROOT, file))) as {
        rules?: Record<string, unknown>;
      };
      const entry = config.rules?.[RULE];
      return Array.isArray(entry) ? entry[0] : entry;
    };
    for (const file of production) expect(await severity(file), file).toBe(2);
    for (const file of tests) {
      expect([undefined, 0], file).toContain(await severity(file));
      expect(TEST_ONLY_RE.test(file), file).toBe(true);
    }
  });

  it("lists only tracked production files, each using every member it is allowed", () => {
    for (const [file, names] of Object.entries(DYNAMIC_LOAD_ALLOWED)) {
      expect(tracked, file).toContain(file);
      expect(file.endsWith(".test.ts"), file).toBe(false);
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const [name, members] of Object.entries(names)) {
        for (const member of members) {
          const head = name === IMPORT_META ? "import\\.meta" : name;
          expect(
            new RegExp(`\\b${head}\\??\\.${member}\\b`, "u").test(text),
            `${file} ${name}.${member}`,
          ).toBe(true);
        }
      }
    }
  });

  it("allows a forbidden key as a string only in tracked files that hold it", () => {
    for (const [file, { binding, keys }] of Object.entries(KEY_LITERAL_ALLOWED)) {
      expect(tracked, file).toContain(file);
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).toContain(`const ${binding} = new Set([`);
      for (const key of keys) expect(text, `${file} ${key}`).toContain(`"${key}"`);
    }
  });

  it("passes on the code in server/ as it is", async () => {
    const results = await eslint.lintFiles(["server"]);
    const found = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === RULE).map((m) => `${r.filePath}:${m.line}`),
    );
    expect(found).toEqual([]);
  });
});
