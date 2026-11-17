import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ROUTE_TABLE } from "../../server/contracts/generated/fake-server/index.ts";
import { releaseLevel, routeRows } from "./level.ts";

// DAN-974-4: the fake server's ROUTE_TABLE is declared without its keys, so a
// new route leaves the .d.ts as it was; the routes are read from the published
// .js instead. Built from the real generated source, compiled as the release
// compiles it (ESM). The added route is invented.

const DIR = "server/contracts/generated/fake-server/";
const SOURCE = readFileSync(new URL(`../../${DIR}index.ts`, import.meta.url), "utf8");
const OPEN = "export const ROUTE_TABLE: Readonly<Record<string, FakeRoute>> = {\n";
const NEW_ROW =
  '  "zz.invented.get": { method: "GET", path: "/api/v1/invented", body: null, headers: [], errors: {} },\n';
const FIRST = Object.keys(ROUTE_TABLE)[0]!;

const js = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  }).outputText;
const dts = (source: string) =>
  ts.transpileDeclaration(source, { compilerOptions: { target: ts.ScriptTarget.ES2023 } })
    .outputText;
const pkg = (source: string, code = js(source), types = dts(source)) =>
  new Map<string, string>([
    ["package.json", JSON.stringify({ name: "@ductura/test-fakes", version: "4.0.0" })],
    [`${DIR}index.js`, code],
    [`${DIR}index.d.ts`, types],
  ]);
const level = (after: Map<string, string>, before = pkg(SOURCE)) =>
  releaseLevel({ short: "test-fakes", before, after, generatorChanged: false });
/** The source with the row of `id` replaced by `row` (empty: removed). */
const editRow = (id: string, row: (line: string) => string) =>
  SOURCE.split("\n")
    .map((line) => (line.startsWith(`  ${JSON.stringify(id)}: `) ? row(line) : line))
    .join("\n");
const withTable = (table: string) =>
  `export const OTHER = 1;\nexport const ROUTE_TABLE = ${table};\n`;

describe("the test-fakes route table (DAN-974-4)", () => {
  it("declares ROUTE_TABLE without its keys", () => {
    expect(SOURCE).toContain(OPEN);
    expect(dts(SOURCE)).not.toContain(JSON.stringify(FIRST));
  });

  it("reads exactly the routes of the real generated table from its compiled JS", () => {
    expect([...routeRows(js(SOURCE), "index.js").rows.keys()]).toEqual(Object.keys(ROUTE_TABLE));
  });

  // Negative cases first: what must stay major.
  it("is major for a removed route", () => {
    const removed = editRow(FIRST, () => "").replace(/\n\n(?=  ")/u, "\n");
    const out = level(pkg(removed));
    expect(out.level).toBe("major");
    expect(out.reasons.join("\n")).toContain(`route ${FIRST} removed`);
  });

  it("is major for a changed path or method of an existing route", () => {
    const path = editRow(FIRST, (l) => l.replace(/path: "([^"]+)"/u, 'path: "$1/x"'));
    const method = editRow(FIRST, (l) => l.replace(/method: "[A-Z]+"/u, 'method: "PATCH"'));
    expect(level(pkg(path)).level).toBe("major");
    expect(level(pkg(method)).level).toBe("major");
  });

  it("is major from the old declaration with listed keys (the 4.0.0 step itself)", () => {
    const asConst = SOURCE.replace(OPEN, "export const ROUTE_TABLE = {\n").replace(
      "\n};\nObject.setPrototypeOf(ROUTE_TABLE, null);\n",
      "\n} as const;\n",
    );
    expect(dts(asConst)).toContain(JSON.stringify(FIRST));
    expect(level(pkg(SOURCE), pkg(asConst)).level).toBe("major");
  });

  it("is major when the table gets its prototype back", () => {
    const withProto = SOURCE.replace("Object.setPrototypeOf(ROUTE_TABLE, null);\n", "");
    expect(withProto).not.toBe(SOURCE);
    expect(routeRows(js(SOURCE), "index.js").nullPrototype).toBe(true);
    expect(level(pkg(withProto)).level).toBe("major");
    expect(level(pkg(SOURCE), pkg(withProto)).level).toBe("patch");
  });

  it.each([
    ["no ROUTE_TABLE", "export const OTHER = 1;\n"],
    ["two ROUTE_TABLEs", withTable("{}") + withTable("{}")],
    ["not an object literal", withTable("Object.freeze({})")],
    ["a computed key", withTable('{ ["a.get"]: {} }')],
    ["a spread", withTable("{ ...{} }")],
    ["a duplicate key", withTable('{ "a.get": {}, "a.get": {} }')],
    ["an identifier key", withTable("{ a: {} }")],
    ["a __proto__ key", withTable('{ "__proto__": {} }')],
    ["__proto__ with a value", withTable("{ __proto__: null }")],
  ])("is blocked for a table it cannot read: %s", (_, code) => {
    const before = pkg(SOURCE, withTable('{ "a.get": { method: "GET" } }'));
    expect(level(pkg(SOURCE, code), before).level).toBe("blocked");
  });

  // The criterion: one added route is not major.
  it("is minor for one added route, with the .d.ts unchanged", () => {
    const added = SOURCE.replace(OPEN, `${OPEN}${NEW_ROW}`);
    expect(dts(added)).toBe(dts(SOURCE));
    const out = level(pkg(added));
    expect(out.level).toBe("minor");
    expect(out.reasons.join("\n")).toContain("route zz.invented.get added");
  });

  it("treats toString like any other route and ignores CRLF", () => {
    const one = withTable('{ "a.get": { method: "GET" } }');
    const two = withTable('{ "a.get": { method: "GET" }, "toString": { method: "GET" } }');
    expect(level(pkg(SOURCE, two), pkg(SOURCE, one)).level).toBe("minor");
    expect(level(pkg(SOURCE, one), pkg(SOURCE, two)).level).toBe("major");
    const crlf = one.replace(/\n/gu, "\r\n");
    expect(level(pkg(SOURCE, crlf), pkg(SOURCE, one)).level).toBe("patch");
  });
});
