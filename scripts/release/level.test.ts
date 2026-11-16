import { describe, expect, it } from "vitest";

import {
  declarationChange,
  latestTag,
  nextVersion,
  releaseLevel,
  type LevelInput,
} from "./level.ts";

// DAN-804: the semver level of an automatic release. Every package, type and
// route here is invented.

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));
const manifest = (exports: Record<string, string>, extra = {}) =>
  JSON.stringify({ name: "@ductura/test-fakes", version: "0.1.0", exports, ...extra });
const BASE_DTS = "export declare function clock(start: number): { now(): number };\n";
const fakes = (dts: string, rest: Record<string, string> = {}) =>
  files({
    "package.json": manifest({ ".": "./index.js" }),
    "index.d.ts": dts,
    "index.js": "export function clock() {}\n",
    ...rest,
  });
const level = (before: LevelInput["before"], after: LevelInput["after"], change = {}) =>
  releaseLevel({ short: "test-fakes", before, after, generatorChanged: false, ...change }).level;

describe("releaseLevel for test-fakes (declarations)", () => {
  const before = fakes(BASE_DTS);
  it.each([
    ["the same bytes", BASE_DTS, {}, "none"],
    ["a comment only", `/** Fake. */\n${BASE_DTS}`, {}, "patch"],
    ["another layout", BASE_DTS.replace("(start: number)", "( start : number )"), {}, "patch"],
    ["a JS fix", BASE_DTS, { "index.js": "export function clock() { return 1; }\n" }, "patch"],
    ["a new export", `${BASE_DTS}export declare const ZERO = 0;\n`, {}, "minor"],
    [
      // Hard cut (#92 c.6906398937): a new member of an existing type is major.
      "a new optional member",
      BASE_DTS.replace("now(): number", "now(): number; tick?: number"),
      {},
      "major",
    ],
    ["a removed export", "export {};\n", {}, "major"],
    ["a renamed export", BASE_DTS.replace("clock", "watch"), {}, "major"],
    ["a narrower parameter", BASE_DTS.replace("start: number", "start: 1"), {}, "major"],
    [
      "a new parameter",
      BASE_DTS.replace("start: number", "start: number, step: number"),
      {},
      "major",
    ],
    [
      "a new required member",
      BASE_DTS.replace("now(): number", "now(): number; tick: number"),
      {},
      "major",
    ],
    ["a removed member", BASE_DTS.replace("{ now(): number }", "{}"), {}, "major"],
    ["a changed return", BASE_DTS.replace("now(): number", "now(): string"), {}, "major"],
    ["a removed file", BASE_DTS, { "index.js": undefined }, "major"],
  ])("%s", (_, dts, rest, expected) => {
    const after = new Map(fakes(dts));
    for (const [path, text] of Object.entries(rest as Record<string, string | undefined>))
      if (text === undefined) after.delete(path);
      else after.set(path, text);
    expect(level(before, after)).toBe(expected);
  });

  it("is major when an optional member becomes required or a union narrows", () => {
    const optional = fakes("export type A = { a?: string; u: 1 | 2 };\n");
    expect(level(optional, fakes("export type A = { a: string; u: 1 | 2 };\n"))).toBe("major");
    expect(level(optional, fakes("export type A = { a?: string; u: 1 };\n"))).toBe("major");
    expect(level(optional, fakes("export type A = { a?: string; u: 1 | 2 | 3 };\n"))).toBe("major");
  });

  it("is major when an interface loses a base or a re-export turns type-only", () => {
    const base = "interface B { b: 1 }\nexport interface A extends B { a: 1 }\n";
    expect(level(fakes(base), fakes(base.replace(" extends B", "")))).toBe("major");
    const value = 'export { clock } from "./clock.js";\n';
    expect(level(fakes(value), fakes(value.replace("{ clock }", "{ type clock }")))).toBe("major");
    expect(level(fakes(value), fakes(value.replace("{ clock }", "{ clock, tick }")))).toBe("minor");
    expect(level(fakes(value), fakes(value.replace("{ clock }", "{ tick as clock }")))).toBe(
      "major",
    );
  });

  it("reads package.json exports: added minor, removed or changed major", () => {
    const with2 = (exports: Record<string, string>, extra = {}) =>
      new Map([...before, ["package.json", manifest(exports, extra)]]);
    expect(level(before, with2({ ".": "./index.js", "./clock": "./c.js" }))).toBe("minor");
    expect(level(with2({ ".": "./index.js", "./clock": "./c.js" }), before)).toBe("major");
    expect(level(before, with2({ ".": "./other.js" }))).toBe("major");
    expect(level(before, with2({ ".": "./index.js" }, { description: "x" }))).toBe("patch");
    expect(level(before, with2({ ".": "./index.js" }, { version: "9.9.9" }))).toBe("none");
  });

  it("is blocked, never patch, when a declaration does not parse", () => {
    const result = releaseLevel({
      short: "test-fakes",
      before,
      after: fakes("export declare function clock(: {\n"),
      generatorChanged: false,
    });
    expect(result.level).toBe("blocked");
    expect(result.reasons.join()).toMatch(/does not parse/);
  });
});

describe("releaseLevel for contracts (OpenAPI and generated types)", () => {
  const route = (props: Record<string, unknown>, required: string[] = []) => ({
    get: {
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": { schema: { type: "object", properties: props, required } },
          },
        },
      },
    },
  });
  const doc = (version: string, paths: Record<string, unknown>, title = "Ductura API") =>
    JSON.stringify({ openapi: "3.1.0", info: { title, version }, paths });
  const OPS = 'export type Operations = {\n  "a.get": { body: { "x": string } };\n};\n';
  const contracts = (openapi: string, ops = OPS, rest: Record<string, string> = {}) =>
    files({
      "package.json": JSON.stringify({ exports: { ".": "./index.js" } }),
      "openapi/v1.json": openapi,
      "server/contracts/generated/types.d.ts": ops,
      ...rest,
    });
  const A = { "/a": route({ x: { type: "string" } }, ["x"]) };
  const before = contracts(doc("1.3.0", A));
  const NEW_ROUTE =
    'export type Operations = {\n  "a.get": { body: { "x": string } };\n  "b.get": { body: undefined };\n};\n';
  const run = (after: LevelInput["after"], generatorChanged = false) =>
    releaseLevel({ short: "contracts", before, after, generatorChanged });

  it("is minor for a new route backed by the document", () => {
    const after = contracts(doc("1.4.0", { ...A, "/b": route({}) }), NEW_ROUTE);
    expect(run(after).level).toBe("minor");
  });

  it("is patch for a description only", () => {
    expect(run(contracts(doc("1.3.1", A, "Ductura API v1"))).level).toBe("patch");
  });

  it("is major for a removed route, whatever the version says", () => {
    const after = contracts(doc("1.4.0", {}), OPS.replace('"a.get"', '"b.get"'));
    const result = run(after);
    expect(result.level).toBe("major");
    expect(result.reasons.join("\n")).toMatch(/route removed/);
  });

  it("is major for a required response field turned optional", () => {
    expect(run(contracts(doc("1.4.0", { "/a": route({ x: { type: "string" } }) }))).level).toBe(
      "major",
    );
  });

  // A false minor: a document that grew hides a breaking change of the types.
  it("is major when a generated type changes beyond the document", () => {
    const narrowed = NEW_ROUTE.replace('"x": string', '"x": "only"');
    expect(run(contracts(doc("1.4.0", { ...A, "/b": route({}) }), narrowed)).level).toBe("major");
  });

  it("is major for a new required generated member when the generator changed", () => {
    const after = contracts(doc("1.4.0", { ...A, "/b": route({}) }), NEW_ROUTE);
    expect(run(after, true).level).toBe("major");
  });

  it("is major for a new required generated member without a minor of the document", () => {
    expect(run(contracts(doc("1.3.0", A), NEW_ROUTE)).level).toBe("major");
    expect(run(contracts(doc("1.3.1", A, "x"), NEW_ROUTE)).level).toBe("major");
  });

  it("is major when the document changed without a rise, blocked when unreadable", () => {
    expect(run(contracts(doc("1.3.0", A, "Other"))).level).toBe("major");
    expect(run(contracts("{ not json")).level).toBe("blocked");
    expect(run(files({ "package.json": "{}" })).level).toBe("blocked");
  });
});

describe("latestTag and nextVersion", () => {
  it("takes the highest strict tag of the package", () => {
    const tags = [
      "contracts-v1.0.0",
      "contracts-v1.10.0",
      "contracts-v1.9.9",
      "contracts-v01.20.0",
      "contracts-v2.0.0-rc.1",
      "contracts-v3.0.0 ",
      "test-fakes-v5.0.0",
      "xcontracts-v9.0.0",
      "",
    ];
    expect(latestTag(tags, "contracts")).toEqual([1, 10, 0]);
    expect(latestTag(["contracts-v1.0.0"], "test-fakes")).toBeNull();
  });

  it("raises minor or patch from the tag, never below package.json", () => {
    expect(nextVersion([1, 2, 3], "minor", "1.0.0")).toEqual([1, 3, 0]);
    expect(nextVersion([1, 2, 3], "patch", "1.0.0")).toEqual([1, 2, 4]);
    expect(nextVersion([1, 2, 3], "patch", "1.5.0")).toEqual([1, 5, 0]);
    expect(nextVersion([0, 1, 1], "minor", "0.1.0")).toEqual([0, 2, 0]);
  });

  it("tags nothing for a major, a blocked level or a pending major", () => {
    for (const level of ["major", "blocked", "none"] as const)
      expect(nextVersion([1, 2, 3], level, "1.0.0")).toMatch(/level/);
    expect(nextVersion([1, 2, 3], "patch", "2.0.0")).toMatch(/owner/);
    expect(nextVersion([1, 2, 3], "patch", "0.9.0")).toMatch(/below/);
    expect(nextVersion([1, 2, 3], "patch", "1.2")).toMatch(/not X\.Y\.Z/);
  });
});

describe("declarationChange", () => {
  it("names what changed", () => {
    const change = declarationChange(BASE_DTS, "export {};\n", "index.d.ts");
    expect(change.level).toBe("changed");
    expect(change.reasons.join()).toMatch(/index\.d\.ts FunctionDeclaration clock: changed/);
  });
});

// Self-attack before SPREMAN (#92): each of these was minor or patch, and is a major.
describe("releaseLevel refuses what merges, shadows or hides in tokens", () => {
  const dts = (before: string, after: string) => level(fakes(before), fakes(after));
  const OPTIONS = "export interface Options { port: number }\n";

  it.each([
    [
      "a second block of an exported interface",
      OPTIONS,
      `${OPTIONS}export interface Options { host: string }\n`,
    ],
    [
      "a declaration of a name already exported",
      "export declare const A: 1;\n",
      "export declare const A: 1;\nexport type A = string;\n",
    ],
    [
      "a new overload",
      "export declare function f(a: string): void;\n",
      "export declare function f(a: string): void;\nexport declare function f(a: number): void;\n",
    ],
    ["declare global", OPTIONS, `${OPTIONS}declare global { interface Window { x: 1 } }\n`],
    ["declare module", OPTIONS, `${OPTIONS}declare module "./a.js" { interface X { y: 1 } }\n`],
    [
      "a new name next to export *",
      'export * from "./a.js";\n',
      'export * from "./a.js";\nexport type X = number;\n',
    ],
    [
      "a duplicate member of a type",
      "export type T = { m(): void };\n",
      "export type T = { m(): void; m(a?: 1): void };\n",
    ],
    ["keyof to readonly", "export type K = keyof O[];\n", "export type K = readonly O[];\n"],
    ["keyof to unique", "export type K = keyof symbol;\n", "export type K = unique symbol;\n"],
    [
      "typeof import to import",
      'export type T = typeof import("./a.js");\n',
      'export type T = import("./a.js");\n',
    ],
    [
      "extends to implements",
      "export declare class A extends B {}\n",
      "export declare class A implements B {}\n",
    ],
    ["const to let", "export declare const A: 1;\n", "export declare let A: 1;\n"],
  ])("%s", (_, before, after) => {
    expect(dts(before, after)).toBe("major");
  });

  it("keeps a new name minor and a comment patch; a new optional member is major", () => {
    expect(dts(OPTIONS, "export interface Options { port: number; host?: string }\n")).toBe(
      "major",
    );
    expect(dts(OPTIONS, `${OPTIONS}export interface Other { host: string }\n`)).toBe("minor");
    expect(dts(OPTIONS, `/** Options. */\n${OPTIONS}`)).toBe("patch");
  });

  it("reads how a package loads as a major", () => {
    const loads = (extra: object) =>
      new Map([...fakes(BASE_DTS), ["package.json", manifest({ ".": "./index.js" }, extra)]]);
    for (const extra of [
      { type: "commonjs" },
      { main: "./x.js" },
      { peerDependencies: { a: "1" } },
    ])
      expect(level(fakes(BASE_DTS), loads(extra))).toBe("major");
  });
});

// Second self-attack pass (#92): a new file, a side-effect import and directives.
describe("releaseLevel reads new files and directives", () => {
  const OPTIONS = "export interface Options { port: number }\n";
  const AUG = 'export {};\ndeclare module "./index.js" { interface Options { host: string } }\n';

  it("is major for an augmentation brought in by a new file", () => {
    const after = fakes(`import "./aug.js";\n${OPTIONS}`, { "aug.d.ts": AUG });
    expect(level(fakes(OPTIONS), after)).toBe("major");
    const global = fakes(OPTIONS, { "global.d.ts": "export {};\ndeclare global { var x: 1 }\n" });
    expect(level(fakes(OPTIONS), global)).toBe("major");
  });

  it("is major for a new import for side effects alone", () => {
    expect(level(fakes(OPTIONS), fakes(`import "./aug.js";\n${OPTIONS}`))).toBe("major");
  });

  it("is minor for a new file of new names", () => {
    const after = fakes(OPTIONS, { "clock.d.ts": "export declare function tick(): void;\n" });
    expect(level(fakes(OPTIONS), after)).toBe("minor");
  });

  it.each([
    '/// <reference types="node" />\n',
    '/// <reference lib="dom" />\n',
    '/// <reference path="./a.d.ts" />\n',
  ])("is major when a directive %j is added or removed", (directive) => {
    expect(level(fakes(OPTIONS), fakes(`${directive}${OPTIONS}`))).toBe("major");
    expect(level(fakes(`${directive}${OPTIONS}`), fakes(OPTIONS))).toBe("major");
  });
});

// Review and Codex on #92: variables by name, attributes, new module references.
describe("releaseLevel for the generated client and module references", () => {
  const route = (props: Record<string, unknown>) => ({
    get: {
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { type: "object", properties: props } } },
        },
      },
    },
  });
  const doc = (version: string, paths: Record<string, unknown>) =>
    JSON.stringify({ openapi: "3.1.0", info: { title: "Ductura API", version }, paths });
  const IMPORT = 'import type { OperationId } from "./types.ts";\n';
  const A = '  readonly "a.get": { readonly method: "GET"; readonly path: "/api/v1/a" };\n';
  const B = '  readonly "b.get": { readonly method: "GET"; readonly path: "/api/v1/b" };\n';
  const client = (...routes: string[]) =>
    `${IMPORT}export declare const ROUTE_TABLE: {\n${routes.join("")}};\nexport type Id = OperationId;\n`;
  const contracts = (openapi: string, dts: string) =>
    files({
      "package.json": "{}",
      "openapi/v1.json": openapi,
      "server/contracts/generated/client.d.ts": dts,
    });
  const before = contracts(doc("1.3.0", { "/a": route({}) }), client(A));
  const run = (after: LevelInput["after"], generatorChanged = false) =>
    releaseLevel({ short: "contracts", before, after, generatorChanged }).level;

  it("is minor for a new route in ROUTE_TABLE backed by the document", () => {
    expect(run(contracts(doc("1.4.0", { "/a": route({}), "/b": route({}) }), client(A, B)))).toBe(
      "minor",
    );
  });

  it("is major for ROUTE_TABLE changes the document does not back", () => {
    expect(run(contracts(doc("1.3.0", { "/a": route({}) }), client(A, B)))).toBe("major");
    const both = contracts(doc("1.4.0", { "/a": route({}), "/b": route({}) }), client(A, B));
    expect(run(both, true)).toBe("major");
    const changed = client(A.replace('"/api/v1/a"', '"/api/v1/x"'), B);
    expect(run(contracts(doc("1.4.0", { "/a": route({}), "/b": route({}) }), changed))).toBe(
      "major",
    );
    expect(run(contracts(doc("1.4.0", { "/a": route({}), "/b": route({}) }), client(B)))).toBe(
      "major",
    );
    expect(
      run(contracts(doc("1.3.0", { "/a": route({}) }), client(A).replace("const", "let"))),
    ).toBe("major");
  });

  it("is major when import attributes of a re-export change", () => {
    const re = (mode: string) =>
      `export type { Foo } from "dual" with { "resolution-mode": "${mode}" };\n`;
    expect(level(fakes(re("import")), fakes(re("require")))).toBe("major");
  });

  it("is major for a reference to a module not referred to before", () => {
    const OPTIONS = "export interface Options { port: number }\n";
    const added = 'import type { Hook } from "./aug.js";\nexport type Added = Hook;\n';
    expect(level(fakes(OPTIONS), fakes(`${OPTIONS}${added}`))).toBe("major");
    const typeImport = 'export type Added = import("./aug.js").Hook;\n';
    expect(level(fakes(OPTIONS), fakes(`${OPTIONS}${typeImport}`))).toBe("major");
    // A module already referred to brings nothing new.
    const known = `${OPTIONS}${added}`;
    expect(level(fakes(known), fakes(`${known}export type More = Hook;\n`))).toBe("minor");
  });
});

// Second review on #92 (c.6906342227): a new name that shadows a global in use.
describe("releaseLevel refuses a new name that shadows what the file used", () => {
  const CLOCK = "export interface FakeClock { now(): Date }\n";

  it("is major when a new type takes the name of a global the file uses", () => {
    expect(level(fakes(CLOCK), fakes(`${CLOCK}export type Date = string;\n`))).toBe("major");
    expect(level(fakes(CLOCK), fakes(`type Date = string;\n${CLOCK}`))).toBe("major");
  });

  it("stays minor for a new name the file never used", () => {
    expect(level(fakes(CLOCK), fakes(`${CLOCK}export type Instant = string;\n`))).toBe("minor");
  });
});

// 2nd fix round on #92 (c.6906398937): raw bytes and names used in any old .d.ts.
describe("releaseLevel over raw bytes and the whole package", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const text = (t: string) => Buffer.from(t, "utf8");

  it("is patch when the only change is a BOM in README.md", () => {
    const before = new Map<string, string | Uint8Array>([
      ...fakes(BASE_DTS),
      ["README.md", text("Lažne zamjene\n")],
    ]);
    const after = new Map<string, string | Uint8Array>([
      ...fakes(BASE_DTS),
      ["README.md", Buffer.concat([BOM, text("Lažne zamjene\n")])],
    ]);
    expect(level(before, after)).toBe("patch");
  });

  it("is patch for a changed file that is not UTF-8 and not parsed", () => {
    const before = new Map<string, string | Uint8Array>([
      ...fakes(BASE_DTS),
      ["data.bin", Buffer.from([0xff, 0x00])],
    ]);
    const after = new Map<string, string | Uint8Array>([
      ...fakes(BASE_DTS),
      ["data.bin", Buffer.from([0xfe, 0x00])],
    ]);
    expect(level(before, after)).toBe("patch");
  });

  it("is blocked when a declaration file is not UTF-8", () => {
    const after = new Map<string, string | Uint8Array>([
      ...fakes(BASE_DTS),
      ["index.d.ts", Buffer.from([0xff, 0xfe])],
    ]);
    expect(level(fakes(BASE_DTS), after)).toBe("blocked");
  });

  it("is major for a new name used in another old declaration file", () => {
    const CLOCK = "export interface FakeClock { now(): Date }\n";
    const before = fakes(BASE_DTS, { "clock.d.ts": CLOCK });
    const after = fakes(`${BASE_DTS}export type Date = string;\n`, { "clock.d.ts": CLOCK });
    expect(level(before, after)).toBe("major");
    const newFile = fakes(BASE_DTS, {
      "clock.d.ts": CLOCK,
      "date.d.ts": "export type Date = string;\n",
    });
    expect(level(before, newFile)).toBe("major");
    const fresh = fakes(`${BASE_DTS}export type Instant = string;\n`, { "clock.d.ts": CLOCK });
    expect(level(before, fresh)).toBe("minor");
  });
});

// Fourth self-attack on #92: order of unnamed signatures, imports that bind a
// used name, every declaration file, open types and the scope marker.
describe("releaseLevel closes the last self-attack findings", () => {
  const dts = (before: string, after: string) => level(fakes(before), fakes(after));

  it.each([
    [
      "reordered call signatures",
      'export type Parse = {\n    (x: string): "text";\n    (x: unknown): "other";\n};\n',
      'export type Parse = {\n    (x: unknown): "other";\n    (x: string): "text";\n};\n',
    ],
    [
      "reordered construct signatures",
      "export interface Make {\n    new (x: string): A;\n    new (x: unknown): B;\n}\n",
      "export interface Make {\n    new (x: unknown): B;\n    new (x: string): A;\n}\n",
    ],
    [
      "a new call signature",
      'export type Parse = {\n    (x: string): "text";\n};\n',
      'export type Parse = {\n    (x: string): "text";\n    (x: number): "n";\n};\n',
    ],
    [
      "a new import aliased to a used global",
      'import { type Server } from "node:http";\nexport declare function stamp(s: Server): Date;\n',
      'import { type Server } from "node:http";\nimport type { Agent as Date } from "node:http";\nexport declare function stamp(s: Server): Date;\n',
    ],
    [
      "a new namespace import",
      'import { type Server } from "node:http";\nexport declare const s: Server;\n',
      'import { type Server } from "node:http";\nimport * as http from "node:http";\nexport declare const s: Server;\n',
    ],
    [
      "a new optional member next to an index signature",
      "export type Bag = {\n    [key: string]: unknown;\n};\n",
      "export type Bag = {\n    [key: string]: unknown;\n    size?: number;\n};\n",
    ],
    [
      "a new optional member in an intersection",
      "type Base = { id: string };\nexport type Item = Base & {\n    name: string;\n};\nexport {};\n",
      "type Base = { id: string };\nexport type Item = Base & {\n    name: string;\n    id?: number;\n};\nexport {};\n",
    ],
    [
      "a new scope marker",
      "declare function helper(): void;\nexport declare function main(): void;\n",
      "declare function helper(): void;\nexport declare function main(): void;\nexport {};\n",
    ],
    [
      "a new export default",
      "declare function helper(): void;\nexport declare function main(): void;\n",
      "declare function helper(): void;\nexport declare function main(): void;\nexport default main;\n",
    ],
  ])("is major for %s", (_, before, after) => {
    expect(dts(before, after)).toBe("major");
  });

  it.each(["a.d.mts", "a.d.cts", "a.d.json.ts"])("reads %s as a declaration file", (path) => {
    const before = fakes(BASE_DTS, { [path]: "export declare const n: number;\n" });
    expect(level(before, fakes(BASE_DTS, { [path]: "export declare const n: string;\n" }))).toBe(
      "major",
    );
    expect(level(before, fakes(BASE_DTS, { [path]: "export {};\n" }))).toBe("major");
  });

  it("is blocked for TypeScript that is not a declaration file", () => {
    expect(level(fakes(BASE_DTS), fakes(BASE_DTS, { "src.ts": "export const n = 1;\n" }))).toBe(
      "blocked",
    );
  });

  it("is major for a new optional member of a plain type too (hard cut)", () => {
    expect(
      dts(
        "export type T = {\n    a: string;\n};\n",
        "export type T = {\n    a: string;\n    b?: number;\n};\n",
      ),
    ).toBe("major");
  });
});

// Final self-attack on #92: the indirect forms that made a new optional member
// narrow what was there. With the hard cut every one of them is major.
describe("releaseLevel after the hard cut on new members", () => {
  const dts = (before: string, after: string) => level(fakes(before), fakes(after));
  it.each([
    [
      "an inherited index signature",
      "interface Base {\n    [key: string]: string | number | undefined;\n}\nexport interface Opts extends Base {\n    name: string;\n}\nexport {};\n",
      "interface Base {\n    [key: string]: string | number | undefined;\n}\nexport interface Opts extends Base {\n    name: string;\n    retries?: number;\n}\nexport {};\n",
    ],
    [
      "extends Record",
      "export interface Meta extends Record<string, string | number | undefined> {\n    id: string;\n}\n",
      "export interface Meta extends Record<string, string | number | undefined> {\n    id: string;\n    weight?: number;\n}\n",
    ],
    [
      "an inherited member narrowed",
      "interface Base {\n    mode?: string;\n}\nexport interface Opts extends Base {\n    name: string;\n}\nexport {};\n",
      'interface Base {\n    mode?: string;\n}\nexport interface Opts extends Base {\n    name: string;\n    mode?: "fast" | "slow";\n}\nexport {};\n',
    ],
    [
      "an intersection through an alias",
      "type Base = {\n    mode?: string;\n};\nexport type Extra = {\n    name: string;\n};\nexport type Opts = Base & Extra;\nexport {};\n",
      'type Base = {\n    mode?: string;\n};\nexport type Extra = {\n    name: string;\n    mode?: "fast" | "slow";\n};\nexport type Opts = Base & Extra;\nexport {};\n',
    ],
    [
      "a union inside an intersection",
      "type Base = {\n    mode?: string;\n};\nexport type Opts = Base & ({\n    name: string;\n} | {\n    id: number;\n});\nexport {};\n",
      'type Base = {\n    mode?: string;\n};\nexport type Opts = Base & ({\n    name: string;\n    mode?: "fast";\n} | {\n    id: number;\n});\nexport {};\n',
    ],
    [
      "a second block of a merged interface",
      "export interface Meta {\n    id: string;\n}\nexport interface Meta {\n    [key: string]: string | undefined;\n}\n",
      "export interface Meta {\n    id: string;\n    weight?: number;\n}\nexport interface Meta {\n    [key: string]: string | undefined;\n}\n",
    ],
    [
      "an empty interface gaining a member",
      "export interface Opts {\n}\n",
      "export interface Opts {\n    name?: string;\n}\n",
    ],
  ])("is major for %s", (_, before, after) => {
    expect(dts(before, after)).toBe("major");
  });
});

// Self-attack after the hard cut (#92): directives kept only as flags, a
// namespace re-export and a nested package.json.
describe("releaseLevel closes the last directive and manifest gaps", () => {
  const OPTIONS = "export interface Options { port: number }\n";

  it.each(['/// <reference no-default-lib="true"/>\n', '/// <amd-module name="x" />\n'])(
    "is major when %j is added or removed",
    (directive) => {
      expect(level(fakes(OPTIONS), fakes(`${directive}${OPTIONS}`))).toBe("major");
      expect(level(fakes(`${directive}${OPTIONS}`), fakes(OPTIONS))).toBe("major");
    },
  );

  it("is major for export * as a name the package used", () => {
    const before = fakes(OPTIONS, { "clock.d.ts": "export type FakeClock = { now(): number };\n" });
    const after = fakes(`${OPTIONS}export * as FakeClock from "./clock.js";\n`, {
      "clock.d.ts": "export type FakeClock = { now(): number };\n",
    });
    expect(level(before, after)).toBe("major");
  });

  it("is major for a nested package.json added or changed", () => {
    const nested = "server/contracts/generated/package.json";
    expect(level(fakes(OPTIONS), fakes(OPTIONS, { [nested]: '{"type":"commonjs"}' }))).toBe(
      "major",
    );
    const before = fakes(OPTIONS, { [nested]: '{"type":"module"}' });
    expect(level(before, fakes(OPTIONS, { [nested]: '{"type":"commonjs"}' }))).toBe("major");
  });
});

// Last self-attack on #92: a typed module namespace and a template literal type.
describe("releaseLevel with a typed module namespace", () => {
  const CLOCK = "export declare function now(): number;\n";
  const TICK = `${CLOCK}export declare function tick(): void;\n`;

  it.each([
    [
      "typeof import",
      'export { now } from "./clock.js";\nexport type Clock = typeof import("./clock.js");\n',
    ],
    [
      "import * as",
      'import * as c from "./clock.js";\nexport declare const fakes: {\n    clock: typeof c;\n};\n',
    ],
    ["export * as", 'export * as clock from "./clock.js";\n'],
    ["import = require", 'import c = require("./clock.js");\nexport type Clock = typeof c;\n'],
    ["export import = require", 'export import c = require("./clock.js");\n'],
  ])("is major for a new export once %s types a namespace", (_, index) => {
    const before = fakes(index, { "clock.d.ts": CLOCK });
    expect(level(before, fakes(index, { "clock.d.ts": TICK }))).toBe("major");
  });

  it("stays minor for a new export when no namespace is typed", () => {
    const index = 'export { now } from "./clock.js";\n';
    expect(level(fakes(index, { "clock.d.ts": CLOCK }), fakes(index, { "clock.d.ts": TICK }))).toBe(
      "minor",
    );
  });

  it("sees names after a template literal type", () => {
    const before = fakes(
      "export type K = `k${string}`;\nexport declare function f(d: Date): void;\n",
    );
    const after = fakes(
      "export type K = `k${string}`;\nexport declare function f(d: Date): void;\n",
      { "date.d.ts": "export declare const Date: number;\n" },
    );
    expect(level(before, after)).toBe("major");
  });
});
