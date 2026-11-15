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
    // Review FAIL c.6892504452: a forbidden key as an exported or bound name.
    'export { createHash as setEngine } from "node:crypto";\n',
    'export * as constructor from "node:crypto";\n',
    'export * as setEngine from "node:crypto";\n',
    'import { createHash } from "node:crypto";\nexport { createHash as constructor };\n',
    'import { createHash as setEngine } from "node:crypto";\nexport const h = setEngine;\n',
    'import * as setEngine from "node:crypto";\nexport const h = setEngine;\n',
    'import setEngine from "node:crypto";\nexport const h = setEngine;\n',
    // Decision c.6892510394: the same names written as strings.
    'export { createHash as "setEngine" } from "node:crypto";\n',
    'import { createHash } from "node:crypto";\nexport { createHash as "constructor" };\n',
    'import { "setEngine" as s } from "node:crypto";\nexport const h = s;\n',
    'export * as "constructor" from "node:crypto";\n',
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
  // DAN-773 (contract Ductus#1836 c.6894826454): a forbidden key fails as a
  // name, whatever the syntactic form around it. Every form of the three
  // review FAILs on ductura/server#56 (c.6894474949, c.6894641035,
  // c.6894762609) and of the task description.
  ...["setEngine", "constructor"].flatMap((name) =>
    at(LOG, "key", [
      // Declarations.
      `export function ${name}(): void {}\n`,
      `export async function* ${name}(): AsyncGenerator<never> {}\n`,
      `export const ${name} = 1;\n`,
      `export let ${name} = 1;\n`,
      `export var ${name} = 1;\n`,
      `export class ${name} {}\n`,
      `export abstract class ${name} {}\n`,
      `export declare function ${name}(): void;\n`,
      `export type ${name} = number;\n`,
      `export interface ${name} {\n  x: number;\n}\n`,
      `function ${name}(): void {}\nexport { ${name} as e };\n`,
      `export const f = function ${name}(): void {};\n`,
      `export const c = class ${name} {};\n`,
      `export function f(${name}: number): number {\n  return 0;\n}\n`,
      `export function f<${name}>(): void {}\n`,
      `export const f = (${name} = 1): number => 0;\n`,
      `export function f(): void {\n  ${name}: for (;;) break ${name};\n}\n`,
      `export function f(): void {\n  try {\n    void 0;\n  } catch (${name}) {\n    void 0;\n  }\n}\n`,
      // Destructuring: nested, defaults, rest.
      `export const { ${name} } = { ${name}: 1 };\n`,
      `export const { a: { ${name} } } = { a: { b: 1 } } as never;\n`,
      `export const { a: { b: ${name} = 1 } } = { a: {} } as never;\n`,
      `export const { a = 1, ...${name} } = {} as never;\n`,
      `export const [${name} = 1] = [] as never;\n`,
      `export const [, ...${name}] = [] as never;\n`,
      `export const [[${name}]] = [[1]];\n`,
      `export function f({ ${name} = 1 }: { ${name}?: number }): number {\n  return 0;\n}\n`,
      // export default with a name and without, export =, export import.
      `export default function ${name}(): void {}\n`,
      `export default class ${name} {}\n`,
      `const ${name} = 1;\nexport default ${name};\n`,
      `export default (function ${name}(): void {});\n`,
      `export default (class ${name} {});\n`,
      `export default { ${name}: 1 };\n`,
      `export default { ${name}() {} };\n`,
      `export default { get ${name}() {\n  return 1;\n} };\n`,
      `export = { ${name}: 1 };\n`,
      `export = function ${name}(): void {};\n`,
      `namespace n {\n  export const a = 1;\n}\nexport import ${name} = n.a;\n`,
      `namespace n {\n  export const a = 1;\n}\nimport ${name} = n.a;\nexport { ${name} as e };\n`,
      // Enum and namespace.
      `export enum E {\n  ${name},\n}\n`,
      `export enum ${name} {\n  A,\n}\n`,
      `export const enum E {\n  ${name} = 1,\n}\n`,
      `export namespace ${name} {\n  export const a = 1;\n}\n`,
      `export namespace n.${name} {\n  export const a = 1;\n}\n`,
      `export declare namespace n {\n  const ${name}: number;\n}\n`,
      `export declare module m {\n  export const ${name}: number;\n}\n`,
      // Spread in an object, extends, parentheses, await, conditional.
      `export = { ...{ ${name}: 1 } };\n`,
      `export default { ...{ ${name}: 1 } };\n`,
      `export const o = { ...{ a: { ${name}: 1 } } };\n`,
      `const ${name} = class {};\nexport default class extends ${name} {}\n`,
      `const ${name} = class {};\nexport default (class extends ${name} {});\n`,
      `const ${name} = class {};\nexport class X extends ${name} {}\n`,
      `const ${name} = class {};\nexport class X implements ${name} {}\n`,
      `export default ((((function ${name}(): void {}))));\n`,
      `export default await (function ${name}(): void {});\n`,
      `export default (Math.random() > 0.5 ? function ${name}(): void {} : function engine(): void {});\n`,
      `export default (0, function ${name}(): void {});\n`,
      `export default (function e(): void {} as unknown as { ${name}: 1 });\n`,
      `export default [function ${name}(): void {}];\n`,
      `export default (() => function ${name}(): void {})();\n`,
      // Members and keys of every kind.
      `export const o = { ${name}: 1 };\n`,
      `const ${name} = 1;\nexport const o = { ${name} };\n`,
      `export const o = { ${name}() {} };\n`,
      `export const o = { set ${name}(v: number) {\n  void v;\n} };\n`,
      `export const v = Math.${name};\n`,
      `export const v = Math?.${name};\n`,
      `export class X {\n  static ${name}(): void {}\n}\n`,
      `export class X {\n  get ${name}(): number {\n    return 1;\n  }\n}\n`,
      `export type T = { ${name}: number };\n`,
      `export type T = { ${name}(): void };\n`,
      `export interface I {\n  ${name}: number;\n}\n`,
      `export type T = Math["abs"] extends infer ${name} ? ${name} : never;\n`,
      `export type T = typeof Math.${name};\n`,
      `export type T = { [${name} in "a"]: 1 };\n`,
      `export const x = { "a": 1 } satisfies { [${name}: string]: number };\n`,
      `export function f(this: { ${name}: 1 }): void {}\n`,
    ]),
  ),
  // Private names (a private #constructor is a parse error).
  ...at(LOG, "key", [
    "export class X {\n  #setEngine = 1;\n}\n",
    "export class X {\n  #setEngine(): void {}\n  f(): boolean {\n    return #setEngine in this;\n  }\n}\n",
    "export class X {\n  static #setEngine = 1;\n  g = X.#setEngine;\n}\n",
    "export class X {\n  setEngine(): void {}\n}\n",
    "export class X {\n  setEngine?: number;\n  declare setEngine2: number;\n}\n",
  ]),
  // Attack pass on this PR: a regular expression carries the key in its
  // source or a group name (also as a \u escape); a raw template piece.
  ...at(LOG, "key", [
    "export const F = Reflect.get(() => 0, /constructor/.source);\n",
    'import * as c from "node:crypto";\nexport const e = Reflect.get(c, /setEngine/.source);\n',
    "export const s = /x/v.flags + /setEngine/dgimsuy.source;\n",
    'export const g = Object.keys(/(?<constructor>a)/u.exec("a")?.groups ?? {})[0];\n',
    "export const s = /\\k<constructor>(?<constructor>a)/.source;\n",
    'export const k = Object.keys(/(?<\\u{63}onstructor>a)/u.exec("a")?.groups ?? {})[0];\n',
    'export const k = Object.keys(/(?<set\\u0045ngine>a)/.exec("a")?.groups ?? {})[0];\n',
    "export const s = String.raw`\\x0constructor`.slice(3);\n",
  ]),
  // The exception is only the key of a class constructor: a method, a
  // property or a member named constructor is not one.
  ...at(LOG, "key", [
    "export const o = { constructor: 1 };\n",
    "export const o = { constructor() {} };\n",
    "export class X {\n  static constructor(): void {}\n}\n",
    "export class X {\n  get constructor(): number {\n    return 1;\n  }\n}\n",
    "export class X {\n  constructor() {\n    void this.constructor;\n  }\n}\n",
    "export class X {\n  constructor(constructor: number) {\n    void constructor;\n  }\n}\n",
    "export class X {\n  constructor(private setEngine: number) {}\n}\n",
    "export class X {\n  constructor() {\n    const setEngine = 1;\n    void setEngine;\n  }\n}\n",
    "export class X {\n  constructor(a = Math.setEngine) {\n    void a;\n  }\n}\n",
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
    // The key of a class constructor, with and without TS parameter
    // properties, overloads and a superclass; ordinary names.
    "export class X {\n  constructor() {}\n}\n",
    "export class X {\n  constructor(private readonly a: number, public b = 1) {}\n}\n",
    "export class X {\n  constructor();\n  constructor(a?: number) {\n    void a;\n  }\n}\n",
    "class B {}\nexport class X extends B {\n  constructor() {\n    super();\n  }\n}\n",
    "export abstract class X {\n  protected constructor(protected a: number) {}\n}\n",
    "export default class {\n  constructor() {}\n}\n",
    "export const C = class {\n  constructor(public engine: string) {}\n};\n",
    "export function construct(engine: number, setEngines: number): number {\n  return engine + setEngines;\n}\n",
    "export const o = { constructed: 1, setEngineering: 2, Constructor: 3, SetEngine: 4 };\n",
    'export const r = /(?<engine>\\u{63}onstruct)/u.test("x") && String.raw`\\x0b`.length > 0;\n',
  ]),
];

describe("local/no-dynamic-load (DAN-770)", () => {
  it.each(failing)("$file fails as $messageId: $code", async ({ file, code, messageId }) => {
    expect(await ids(file, code)).toContain(messageId);
  });

  it.each(passing)("$file passes: $code", async ({ file, code }) => {
    expect(await ids(file, code)).toEqual([]);
  });

  // A fixture that does not parse would pass or fail for the wrong reason.
  it.each([...failing, ...passing])("$file parses: $code", async ({ file, code }) => {
    const [result] = await eslint.lintText(code, { filePath: file });
    expect(result?.messages.filter((m) => m.fatal === true)).toEqual([]);
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
