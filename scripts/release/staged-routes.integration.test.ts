import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { planRelease, readTree, type ReleaseIo } from "./auto.ts";
import { TEST_FAKES } from "./manifest.ts";
import { stagePackage } from "./stage.ts";
import { ROUTES_JS, stagedRoutes, PUBLIC_ROUTES_JS } from "./staged-routes.ts";
import { releaseLevel, type Files } from "./level.ts";

// DAN-974-4a: the release level of test-fakes reads the routes the published
// fake server really exports, after its module ran, from a real `node`
// process. Built from the real generated source on main; the added route and
// every small module here are invented.

const DIR = "server/contracts/generated/fake-server/";
const read = (name: string) =>
  readFileSync(new URL(`../../${DIR}${name}`, import.meta.url), "utf8");
const SOURCE = read("index.ts");
const VECTORS = read("vectors.json");
const OPEN = "export const ROUTE_TABLE = {\n";
const FIRST = /\n {2}("[^"]+"): /u.exec(SOURCE.slice(SOURCE.indexOf(OPEN)))![1]!;
/** A route with headers, so emptying them is a change. */
const WITH_HEADERS = /\n {2}("[^"]+"): [^\n]*headers: \["/u.exec(SOURCE)![1]!;
const NEW_ROW =
  '  "zz.invented.get": { method: "GET", path: "/api/v1/invented", body: null, headers: [], errors: {} },\n';
// The declaration file of 974-4b: a record, so a new route does not change it.
const DTS =
  "export type Route = { readonly method: string };\nexport declare const ROUTE_TABLE: Readonly<Record<string, Route>>;\n";
const PUBLIC = 'export * from "../../../server/contracts/generated/fake-server/index.js";\n';

const js = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  }).outputText;
const pkg = (code: string, rest: Record<string, string> = {}): Files =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "@ductura/test-fakes", type: "module" }),
      [ROUTES_JS]: code,
      [`${DIR}index.d.ts`]: DTS,
      [`${DIR}vectors.json`]: VECTORS,
      [PUBLIC_ROUTES_JS]: PUBLIC,
      ...rest,
    }),
  );
const BASE = pkg(js(SOURCE));
const level = (after: Files, before = BASE, timeout = 20_000) =>
  releaseLevel({
    short: "test-fakes",
    before,
    after,
    generatorChanged: false,
    routes: (files) => stagedRoutes(files, timeout),
  });
const append = (code: string) => pkg(js(`${SOURCE}\n${code}\n`));
const small = (code: string) => pkg(code);
const SMALL = small('export const ROUTE_TABLE = { "a.get": { method: "GET", headers: [] } };\n');

describe("the routes the published fake server exports (DAN-974-4a)", () => {
  it("reads every route of the real generated table", () => {
    const routes = stagedRoutes(BASE);
    expect(routes.size).toBeGreaterThan(40);
    expect(routes.has(JSON.parse(FIRST) as string)).toBe(true);
  });

  // Negative cases first: what must stay major.
  it.each([
    ["a removed route", pkg(js(SOURCE.replace(new RegExp(`\\n {2}${FIRST}: [^\\n]*`, "u"), "")))],
    [
      "a row emptied after the literal",
      append(`Object.assign(ROUTE_TABLE[${WITH_HEADERS}], { headers: [] });`),
    ],
    [
      "headers truncated after the literal",
      append(`ROUTE_TABLE[${WITH_HEADERS}].headers.length = 0;`),
    ],
    ["a route deleted after the literal", append(`delete ROUTE_TABLE[${FIRST}];`)],
    ["a changed path", pkg(js(SOURCE.replace(/path: "\/api\/v1\//u, 'path: "/api/v2/')))],
    [
      "a changed public entry",
      pkg(js(SOURCE), { [PUBLIC_ROUTES_JS]: `${PUBLIC}export const ROUTE_TABLE = {};\n` }),
    ],
    // A module that lies through Reflect.ownKeys still loses the route: the child took it first.
    [
      "a removal behind a replaced Reflect",
      append(
        `const own = Reflect.ownKeys; const keys = own(ROUTE_TABLE); Reflect.ownKeys = (o) => (o === ROUTE_TABLE ? keys : own(o)); delete ROUTE_TABLE[${FIRST}];`,
      ),
    ],
  ])("is major for %s", (_, after) => {
    expect(level(after).level).toBe("major");
  });

  it.each([
    ["a module that throws", "throw new Error('no');\n"],
    ["no ROUTE_TABLE", "export const OTHER = 1;\n"],
    ["a getter", 'export const ROUTE_TABLE = { "a.get": { get method() { return "GET"; } } };\n'],
    [
      "a non-enumerable field",
      'export const ROUTE_TABLE = { "a.get": Object.defineProperty({}, "method", { value: "GET" }) };\n',
    ],
    ["a function", 'export const ROUTE_TABLE = { "a.get": { method: () => "GET" } };\n'],
    ["a symbol key", 'export const ROUTE_TABLE = { "a.get": { [Symbol("x")]: 1 } };\n'],
    ["a Proxy", 'export const ROUTE_TABLE = new Proxy({ "a.get": { method: "GET" } }, {});\n'],
    [
      "a class instance",
      'class R { method = "GET"; }\nexport const ROUTE_TABLE = { "a.get": new R() };\n',
    ],
    ["undefined", 'export const ROUTE_TABLE = { "a.get": { body: undefined } };\n'],
    ["NaN", 'export const ROUTE_TABLE = { "a.get": { n: NaN } };\n'],
    ["minus zero", 'export const ROUTE_TABLE = { "a.get": { n: -0 } };\n'],
    ["an array with a hole", 'export const ROUTE_TABLE = { "a.get": { headers: [, "x"] } };\n'],
    [
      "an array with an extra key",
      'const h = ["x"]; h.extra = 1;\nexport const ROUTE_TABLE = { "a.get": { headers: h } };\n',
    ],
    ["output that is not a snapshot", 'process.stdout.write("[1]"); process.exit(0);\n'],
    // Codex #285: diagnostics that look like a snapshot, then exit 0 before the snapshot.
    [
      "a snapshot-like diagnostic",
      'process.stdout.write(\'[["a.get","GET"]]\'); process.exit(0);\n',
    ],
    ["a row that is not an object", 'export const ROUTE_TABLE = { "a.get": "GET" };\n'],
    // DAN-974-4b (Codex #285): a descriptor field inherited from Object.prototype does not count.
    ...["value", "get", "set"].map((name): [string, string] => [
      `an inherited ${name} with a getter`,
      `Object.prototype.${name} = "GET";\nexport const ROUTE_TABLE = { "a.get": { get method() { return "POST"; } } };\n`,
    ]),
  ])("is blocked for %s", (_, code) => {
    expect(level(small(code), SMALL).level).toBe("blocked");
  });

  it("is blocked for a module that never finishes, without the reader or with one side only", () => {
    expect(level(small("while (true) {}\n"), SMALL, 1500).level).toBe("blocked");
    expect(
      releaseLevel({
        short: "test-fakes",
        before: BASE,
        after: append("// x"),
        generatorChanged: false,
      }).level,
    ).toBe("blocked");
    const without = new Map(BASE);
    without.delete(ROUTES_JS);
    expect(level(BASE, without).level).toBe("blocked");
  });

  // DAN-974-4b: every built-in the reader uses after the import was taken before it.
  it("is not fooled by a module that replaces built-ins after its own import", () => {
    const tamper = [
      "const keep = Object.keys;",
      "Reflect.ownKeys = (o) => keep(o).slice(1);",
      "Object.getOwnPropertyDescriptor = () => ({ value: 1, enumerable: true });",
      "Object.hasOwn = () => true;",
      "JSON.stringify = () => '[]';",
      "Array.isArray = () => false;",
      "for (const m of ['push', 'map', 'forEach', 'sort', 'slice']) Array.prototype[m] = function () { return []; };",
      "Array.prototype[Symbol.iterator] = function* () {};",
      "Object.prototype.toJSON = () => 0; Array.prototype.toJSON = () => 0;",
      "Object.defineProperty(Array.prototype, '0', { set() {}, configurable: true });",
      `delete ROUTE_TABLE[${FIRST}];`,
    ].join("\n");
    expect(level(append(tamper)).level).toBe("major");
  });

  // DAN-974-4b (Codex #285): the generated module is the same, only a JS file it imports changed.
  it("is major for a route removed in a dependency of an unchanged fake server", () => {
    const entry = 'import { rows } from "./rows.js";\nexport const ROUTE_TABLE = rows;\n';
    const rows = (body: string) =>
      pkg(entry, { [`${DIR}rows.js`]: `export const rows = ${body};\n` });
    const two = rows('{ "a.get": { method: "GET" }, "b.get": { method: "GET" } }');
    const one = rows('{ "a.get": { method: "GET" } }');
    expect(one.get(ROUTES_JS)).toBe(two.get(ROUTES_JS));
    expect(level(one, two).level).toBe("major");
  });

  // DAN-974-4c (Codex #290): the public entry runs the guard first, as a consumer's import does.
  it("is major for a route removed by the guard the public entry imports", () => {
    const entry = `import "../guard/index.js";\n${PUBLIC}`;
    const guard = (body: string) =>
      pkg(js(SOURCE), { [PUBLIC_ROUTES_JS]: entry, "packages/test-fakes/guard/index.js": body });
    const quiet = guard("export {};\n");
    const removing = guard(
      `import { ROUTE_TABLE } from "../../../server/contracts/generated/fake-server/index.js";\ndelete ROUTE_TABLE[${FIRST}];\n`,
    );
    expect(removing.get(PUBLIC_ROUTES_JS)).toBe(quiet.get(PUBLIC_ROUTES_JS));
    expect(removing.get(ROUTES_JS)).toBe(quiet.get(ROUTES_JS));
    expect(level(removing, quiet).level).toBe("major");
  });

  it("reads the routes of the really staged package through its guard and oidc-provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-routes-real-"));
    try {
      const staged = readTree(stagePackage(TEST_FAKES, dir));
      expect(Buffer.from(staged.get(PUBLIC_ROUTES_JS) ?? "").toString("utf8")).toContain("guard");
      expect([...stagedRoutes(staged).keys()]).toEqual([...stagedRoutes(BASE).keys()]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores what the module prints", () => {
    const noisy = small(
      `console.log('[["a.get","GET"]]');\n${'export const ROUTE_TABLE = { "a.get": { method: "GET", headers: [] } };\n'}`,
    );
    expect(level(noisy, SMALL).level).toBe("patch");
  });

  // Codex #285: the automatic release passes stagedRoutes itself.
  it("is used by planRelease without a reader of its own", () => {
    const added = pkg(js(SOURCE.replace(OPEN, `${OPEN}${NEW_ROW}`)));
    const io = (head: Files): ReleaseIo => ({
      tags: ["test-fakes-v4.0.0"],
      ancestorCommit: () => "a".repeat(40),
      stagedAt: () => BASE,
      stagedHead: () => head,
      generatorChanged: () => false,
      floor: () => "4.0.0",
    });
    expect(planRelease("test-fakes", io(added))).toMatchObject({ release: "test-fakes-v4.1.0" });
    expect(planRelease("test-fakes", io(append(`delete ROUTE_TABLE[${FIRST}];`))).level).toBe(
      "major",
    );
  });

  // The criterion: one added route is not major.
  it("is minor for one added route", () => {
    const out = level(pkg(js(SOURCE.replace(OPEN, `${OPEN}${NEW_ROW}`))));
    expect(out.level).toBe("minor");
    expect(out.reasons.join("\n")).toContain("route zz.invented.get added");
  });

  it("treats toString, constructor and __proto__ as routes like any other and ignores CRLF", () => {
    const more = small(
      'export const ROUTE_TABLE = { "a.get": { method: "GET", headers: [] }, toString: {}, constructor: {}, ["__proto__"]: {} };\n',
    );
    expect(stagedRoutes(more).size).toBe(4);
    expect(level(more, SMALL).level).toBe("minor");
    expect(level(SMALL, more).level).toBe("major");
    const crlf = js(SOURCE).replace(/\n/gu, "\r\n");
    expect(level(pkg(crlf)).level).toBe("patch");
    expect(level(BASE).level).toBe("none");
  });
});
