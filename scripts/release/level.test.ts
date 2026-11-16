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
      "a new optional member",
      BASE_DTS.replace("now(): number", "now(): number; tick?: number"),
      {},
      "minor",
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
