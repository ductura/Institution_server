// No operator route may go around step 8 of the pipeline (S-1J.2, DAN-842-2;
// contract Ductus#1836 c.6947114430). Step 8 reads only the request path, so a
// route bypasses it when its contract path is outside /api/v1/ops, when the
// entry point builds its layers without createLayers or swaps step 8, when a
// contract is mounted that is not one of ROUTES, or when another HTTP server
// serves requests outside startServer. A cross-area test (docs/server-map.md
// §2), as contract-only.test.ts. The checks are pure functions over text and
// data; each has failing synthetic inputs next to the live check.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import {
  AREA_NAMES,
  createAuthRoutes,
  createClientContextRoute,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createEvidenceReplayRouteFor,
  createHealthRoute,
  createInterfaceLocaleRoutesFor,
  createLayers,
  createSettingsValuesPutRoute,
  createWebAuthnRoutesFor,
  PIPELINE_STEPS,
  routesOf,
} from "../../server/http/index.ts";
import { isOpsPath } from "../../server/traffic/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type RouteLike = { readonly id: string; readonly path: string };

/** An operator route declares itself twice: id area `ops` and a path under /api/v1/ops. */
export function operatorRouteProblems(routes: readonly RouteLike[]): string[] {
  return routes.flatMap(({ id, path }) => {
    const byId = id.split(".", 1)[0] === "ops";
    const byPath = isOpsPath(path);
    if (byId && !byPath) return [`${id}: operator route outside /api/v1/ops`];
    if (!byId && byPath) return [`${id}: ${path} is an operator path, the id is not ops.*`];
    return [];
  });
}

/** Mounted contracts that are not members of ROUTES (by identity). */
export function strayContracts(mounted: readonly object[], routes: readonly object[]): number {
  return mounted.filter((contract) => !routes.includes(contract)).length;
}

// Every factory server/server.ts mounts in its routes list, and how this test
// builds it: over stand-ins that are never called, since building a route
// only captures its ports (auth loads its settings on the first request).
const UNUSED = new Proxy({}, { get: () => () => Promise.reject(new Error("not called")) });
const ENTRY_FACTORIES: Readonly<Record<string, () => readonly { contract: RouteLike }[]>> = {
  createHealthRoute: () => [createHealthRoute({ health: UNUSED as never, serverVersion: "0" })],
  createClientContextRoute: () => [createClientContextRoute()],
  createEvidenceOpenRoute: () => [createEvidenceOpenRoute(UNUSED as never)],
  createSettingsValuesPutRoute: () => [createSettingsValuesPutRoute({ writer: UNUSED as never })],
  createInterfaceLocaleRoutesFor: () => createInterfaceLocaleRoutesFor(UNUSED as never),
  createWebAuthnRoutesFor: () => createWebAuthnRoutesFor(UNUSED as never, null),
  createEvidenceCommitRouteFor: () => [
    createEvidenceCommitRouteFor(UNUSED as never, UNUSED as never),
  ],
  createEvidenceReplayRouteFor: () => [
    createEvidenceReplayRouteFor(UNUSED as never, UNUSED as never),
  ],
  createAuthRoutes: () => createAuthRoutes({}),
  routesOf: () => routesOf(AREA_NAMES),
};

/**
 * The factory named by each entry of the routes list of startServer in the
 * entry text; an entry that is not a call of a factory is named as itself.
 */
export function entryRouteFactories(entry: string): string[] {
  const text = flat(code(entry));
  const start = text.indexOf("routes: [");
  if (start < 0) return ["no routes list"];
  let depth = 0;
  let end = -1;
  for (let i = start + "routes: ".length; i < text.length; i += 1) {
    if ("([{".includes(text[i]!)) depth += 1;
    if (")]}".includes(text[i]!)) depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = text.slice(start + "routes: [".length, end);
  const entries: string[] = [];
  let level = 0;
  let current = "";
  for (const char of body) {
    if ("([{".includes(char)) level += 1;
    if (")]}".includes(char)) level -= 1;
    if (char === "," && level === 0) {
      entries.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim() !== "") entries.push(current.trim());
  return entries.map(factoryOf);
}

/**
 * The factory an entry calls, when the entry is that call and nothing more:
 * `f(…)` or `...f(…)`. Anything chained after the call (`.map(…)`, `[0]`)
 * could change what the factory gives, so the entry is named as itself.
 */
function factoryOf(item: string): string {
  const name = /^(?:\.\.\.)?([A-Za-z]\w*)\(/u.exec(item);
  if (name === null) return item;
  let depth = 0;
  for (let i = name[0].length - 1; i < item.length; i += 1) {
    if ("([{".includes(item[i]!)) depth += 1;
    if (")]}".includes(item[i]!)) depth -= 1;
    if (depth === 0) return i === item.length - 1 ? (name[1] ?? item) : item;
  }
  return item;
}

/** Entries of the routes list this test does not build, so it cannot check their contracts. */
export function unknownEntryRoutes(entry: string): string[] {
  return entryRouteFactories(entry).filter((name) => !Object.hasOwn(ENTRY_FACTORIES, name));
}

/** Whitespace as one space: CRLF, tab and NBSP change nothing. */
const flat = (text: string): string => text.replace(/[\s ]+/gu, " ");
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
const count = (text: string, word: string): number => text.split(word).length - 1;

const LAYERS_INIT =
  "const LAYERS = createLayers({ expectedOrigin: APP_ORIGIN, trustedProxies: TRUSTED_PROXIES ?? [], });";

/** server/server.ts builds the layers once, through createLayers, and swaps no step. */
export function entryLayerProblems(entry: string): string[] {
  const text = flat(code(entry));
  const problems: string[] = [];
  if (!text.includes(LAYERS_INIT)) problems.push("LAYERS is not exactly createLayers(…)");
  if (count(text, "createLayers(") !== 1) problems.push("createLayers( not exactly once");
  if (count(text, "startServer(") !== 1) problems.push("startServer( not exactly once");
  if (count(text, "layers:") !== 1 || !text.includes("layers: LAYERS,"))
    problems.push("layers: not exactly layers: LAYERS");
  // In the whole text, comments too: the check is coarse on purpose.
  for (const word of ["operatorPolicy", "secondFactor"])
    if (flat(entry).includes(word)) problems.push(`${word} in the entry point`);
  return problems;
}

// The value imports from node:http and node:net each file under server/ may
// have, exact. start.ts is the server behind the pipeline; app.ts is the
// transitional server no entry imports (below); the fake server is generated
// for clients and never runs in production. Type-only imports are free.
const SERVER_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "server/http/start.ts": ["http createServer", "net Server as NetServer"],
  "server/app.ts": ["http createServer"],
  "server/contracts/generated/fake-server/index.ts": ["http createServer"],
  "server/http/problem.ts": ["http STATUS_CODES"],
  "server/http/security-headers.ts": ["http STATUS_CODES"],
  "server/http/webauthn.ts": ["net isIP"],
  "server/log/events/catalog.ts": ["net isIPv6"],
  "server/traffic/client-ip.ts": ["net isIPv6"],
};

const NODE_IMPORT =
  /\b(import|export)\s+(?!type\s)([^;]*?)\s*from\s*["'](?:node:)?(http|net)["']|\bimport\s*["'](?:node:)?(?:http|net)["']/gu;
// import("node:http") and require("node:http") load every value: never allowed.
const NODE_LOAD = /\b(?:import|require)\s*\(\s*["'`](?:node:)?(http|net)["'`]/gu;

/** "module name" for each value a file imports or re-exports from node:http or node:net. */
export function nodeServerImports(source: string): string[] {
  const values: string[] = [];
  for (const match of flat(code(source)).matchAll(NODE_LOAD)) values.push(`${match[1]} load`);
  for (const match of flat(code(source)).matchAll(NODE_IMPORT)) {
    const [, , clause, module] = match;
    if (clause === undefined || module === undefined) {
      values.push("side-effect import");
      continue;
    }
    const braces = /^\{(.*)\}$/u.exec(clause.trim());
    if (braces === null) {
      values.push(`${module} ${clause.trim()}`); // default or namespace: never allowed
      continue;
    }
    for (const item of (braces[1] ?? "").split(",").map((part) => part.trim())) {
      if (item !== "" && !item.startsWith("type ")) values.push(`${module} ${item}`);
    }
  }
  return values.sort();
}

/** Files whose value imports differ from SERVER_IMPORTS, and listed files that are gone. */
export function serverImportProblems(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of files) {
    const have = nodeServerImports(source).join(", ");
    const allowed = [...(SERVER_IMPORTS[file] ?? [])].sort().join(", ");
    if (have !== allowed)
      problems.push(`${file}: imports ${have || "none"}, allowed ${allowed || "none"}`);
  }
  for (const file of Object.keys(SERVER_IMPORTS))
    if (!files.has(file)) problems.push(`${file}: listed, not found`);
  return problems;
}

// How often each file that may build a server names what builds or binds
// one, outside its imports and comments, exact: a second server inside an
// allowed file (a second createServer, an alias of it, a second listen, the
// router served without the pipeline) changes a count.
const SERVER_USES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "server/http/start.ts": { createServer: 1, ["NetServer"]: 1, listen: 1, createRouter: 1 },
  "server/app.ts": { createServer: 1, listen: 0 },
  "server/contracts/generated/fake-server/index.ts": { createServer: 1, listen: 0 },
};
// The one place start.ts may name the router: inside the pipeline.
const PIPELINE_CALL =
  "createPipeline(options.layers, createRouter(options.routes, report), report)";

/** Counts of SERVER_USES that differ, and a router outside the pipeline in start.ts. */
export function serverUseProblems(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, uses] of Object.entries(SERVER_USES)) {
    const source = files.get(file);
    if (source === undefined) {
      problems.push(`${file}: listed, not found`);
      continue;
    }
    const body = flat(code(source)).replace(
      /\b(?:import|export)\s[^;]*?\sfrom\s*["'][^"']*["'];?/gu,
      "",
    );
    for (const [word, expected] of Object.entries(uses)) {
      const found = body.match(new RegExp(`\\b${word}\\b`, "gu"))?.length ?? 0;
      if (found !== expected)
        problems.push(`${file}: ${word} ${found} times, expected ${expected}`);
    }
    if (file === "server/http/start.ts" && !body.includes(PIPELINE_CALL))
      problems.push(`${file}: the router is not served through the pipeline`);
  }
  return problems;
}

/** Files under server/ that import server/app.ts. */
export function appImporters(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([file, source]) =>
    [...source.matchAll(/\bfrom\s*["'](\.[^"']*)["']|\bimport\s*\(?\s*["'](\.[^"']*)["']/gu)]
      .map((m) => m[1] ?? m[2] ?? "")
      .some((spec) => join(dirname(file), spec) === join("server", "app.ts"))
      ? [file]
      : [],
  );
}

function productionSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = join(dir, name);
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        files.set(path.split(sep).join("/"), readFileSync(join(ROOT, path), "utf8"));
    }
  };
  walk("server");
  return files;
}

describe("operator routes cannot go around step 8", () => {
  it.each([
    [{ id: "ops.traffic.get", path: "/api/v1/traffic" }],
    [{ id: "settings.network.get", path: "/api/v1/ops/network" }],
    [{ id: "settings.root.get", path: "/api/v1/ops" }],
    // Not a contract path (check.ts: path === pathOf(inventory)); synthetic only.
    [{ id: "platform.x.get", path: "/api/v1/OPS/x" }],
    [{ id: "platform.x.get", path: "//api/v1//ops/x" }],
  ])("refuses a route that declares itself only once: %o", (route) => {
    expect(operatorRouteProblems([route])).toHaveLength(1);
  });

  it.each([
    [{ id: "ops.traffic.get", path: "/api/v1/ops/traffic" }],
    [{ id: "opsx.y.get", path: "/api/v1/opsx/y" }],
    [{ id: "platform.ops.get", path: "/api/v1/health" }],
  ])("accepts %o", (route) => {
    expect(operatorRouteProblems([route])).toEqual([]);
  });

  it("holds for every contract and every route server/server.ts mounts", () => {
    const entry = readFileSync(join(ROOT, "server/server.ts"), "utf8");
    expect(unknownEntryRoutes(entry)).toEqual([]);
    // Every factory of the list is in the entry, so none is built here for nothing.
    expect(new Set(entryRouteFactories(entry))).toEqual(new Set(Object.keys(ENTRY_FACTORIES)));
    const mounted = entryRouteFactories(entry)
      .flatMap((name) => ENTRY_FACTORIES[name]!())
      .map((route) => route.contract);
    expect(mounted.length).toBeGreaterThan(10);
    expect(operatorRouteProblems(ROUTES)).toEqual([]);
    expect(operatorRouteProblems(mounted)).toEqual([]);
    expect(strayContracts(mounted, ROUTES)).toBe(0);
    expect(strayContracts([{ ...ROUTES[0]! }], ROUTES)).toBe(1);
  });

  const ENTRY = readFileSync(join(ROOT, "server/server.ts"), "utf8");
  it.each([
    ["a new factory", (t: string) => t.replace("routes: [", "routes: [ createRogueRoute(),")],
    ["a route value", (t: string) => t.replace("routes: [", "routes: [ ROGUE_ROUTE,")],
    ["a spread list", (t: string) => t.replace("routes: [", "routes: [ ...ROGUE_ROUTES,")],
    ["an inline route", (t: string) => t.replace("routes: [", "routes: [ { contract, handle },")],
    [
      "a call chained after the factory",
      (t: string) =>
        t.replace(
          "...createAuthRoutes(process.env),",
          '...createAuthRoutes(process.env).map((r) => ({ ...r, contract: { ...r.contract, id: "ops.x.get" } })),',
        ),
    ],
    [
      "an index after the factory",
      (t: string) => t.replace("createClientContextRoute(),", "createClientContextRoute()[0],"),
    ],
    [
      "a list joined after the factory",
      (t: string) => t.replace("...routesOf(AREAS)", "...routesOf(AREAS).concat([rogueRoute])"),
    ],
    [
      "a factory under another name",
      (t: string) => t.replace("...routesOf(AREAS)", "...routesOfAll(AREAS)"),
    ],
  ])("refuses a mounted route this test cannot check: %s", (_name, swap) => {
    const changed = swap(ENTRY);
    expect(changed).not.toBe(ENTRY);
    expect(unknownEntryRoutes(changed)).toHaveLength(1);
  });

  const SWAPS: readonly [string, (text: string) => string][] = [
    [
      "a spread with step 8 swapped",
      (t) => t.replace("const LAYERS = createLayers({", "const LAYERS = { ...createLayers({"),
    ],
    [
      "a computed key",
      (t) =>
        t.replace(
          "trustedProxies: TRUSTED_PROXIES ?? [],",
          'trustedProxies: TRUSTED_PROXIES ?? [], ["operator" + "Policy"]: pass,',
        ),
    ],
    [
      "a shorthand port",
      (t) =>
        t.replace(
          "trustedProxies: TRUSTED_PROXIES ?? [],",
          "trustedProxies: TRUSTED_PROXIES ?? [], secondFactor,",
        ),
    ],
    [
      "a second createLayers",
      (t) => `${t}\nconst OTHER = createLayers({ expectedOrigin: null });\n`,
    ],
    ["inline layers", (t) => t.replace("layers: LAYERS,", "layers: { ...LAYERS },")],
    ["a second server", (t) => `${t}\nvoid startServer(options);\n`],
    ["a comment naming step 8", (t) => `// operatorPolicy is left as is\n${t}`],
  ];
  it.each(SWAPS)("refuses an entry point with %s", (_name, swap) => {
    const changed = swap(ENTRY);
    expect(changed).not.toBe(ENTRY);
    expect(entryLayerProblems(changed)).not.toEqual([]);
  });

  it("accepts server/server.ts, also with CRLF, tabs and NBSP", () => {
    expect(entryLayerProblems(ENTRY)).toEqual([]);
    expect(entryLayerProblems(ENTRY.replaceAll("\n", "\r\n").replaceAll("  ", "\t"))).toEqual([]);
    expect(entryLayerProblems(ENTRY.replace("createLayers({", "createLayers({ "))).toEqual([]);
  });

  it.each([
    ["server/x.ts", 'import { createServer } from "node:http";'],
    ["server/x.ts", 'import { createServer as cs } from "node:http";'],
    ["server/x.ts", 'import { Server } from "http";'],
    ["server/x.ts", 'import * as net from "node:net";'],
    ["server/x.ts", 'import http from "node:http";'],
    ["server/x.ts", 'export { createServer } from "node:http";'],
    ["server/x.ts", 'import "node:http";'],
    ["server/x.ts", 'const { createServer } = await import("node:http");'],
    ["server/x.ts", "const http = await import ( 'http' );"],
    ["server/x.ts", "const net = require(`node:net`);"],
    [
      "server/http/start.ts",
      'import { createServer } from "node:http";\nconst h = await import("node:http");',
    ],
    ["server/x.ts", 'import {\r\n\ttype IncomingMessage, createServer,\r\n} from "node:http";'],
    ["server/http/start.ts", 'import { createServer, Server } from "node:http";'],
  ])("refuses %s with %j", (file, source) => {
    const problems = serverImportProblems(new Map([...productionSources(), [file, source]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${file}: imports (?!none)`, "u"));
  });

  it("accepts type-only imports", () => {
    const source =
      'import type { Server } from "node:http";\nimport { type Socket } from "node:net";';
    expect(nodeServerImports(source)).toEqual([]);
  });

  const START = readFileSync(join(ROOT, "server/http/start.ts"), "utf8");
  it.each([
    [
      "a second server over the bare router",
      (t: string) =>
        t.replace(
          "  const shutdown = options.shutdown",
          "  createServer(createRouter(options.routes, report)).listen(0, options.host).unref();\n  const shutdown = options.shutdown",
        ),
    ],
    [
      "an alias of createServer",
      (t: string) =>
        t.replace(
          "  const shutdown = options.shutdown",
          "  const cs = createServer;\n  const shutdown = options.shutdown",
        ),
    ],
    [
      "a second listen",
      (t: string) =>
        t.replace(
          "  const shutdown = options.shutdown",
          "  void handle;\n  net.listen(1);\n  const shutdown = options.shutdown",
        ),
    ],
    [
      "the router outside the pipeline",
      (t: string) =>
        t.replace(
          PIPELINE_CALL,
          "createPipeline(options.layers, async () => {}, report); const r = createRouter(options.routes, report)",
        ),
    ],
    [
      "a second NetServer",
      (t: string) =>
        t.replace(
          "  const shutdown = options.shutdown",
          "  new NetServer().listen(0);\n  const shutdown = options.shutdown",
        ),
    ],
  ])("refuses start.ts with %s", (_name, swap) => {
    const changed = swap(START);
    expect(changed).not.toBe(START);
    const files = new Map(productionSources());
    files.set("server/http/start.ts", changed);
    expect(serverUseProblems(files)).not.toEqual([]);
    expect(serverImportProblems(files)).toEqual([]);
  });

  it("refuses a second server in another allowed file", () => {
    const files = new Map(productionSources());
    files.set(
      "server/app.ts",
      `${files.get("server/app.ts")!}\nexport const other = () => createServer(() => {}).listen(0);\n`,
    );
    expect(serverUseProblems(files)).toEqual([
      "server/app.ts: createServer 2 times, expected 1",
      "server/app.ts: listen 1 times, expected 0",
    ]);
  });

  it("counts every server use in the allowed files exactly", () => {
    expect(serverUseProblems(productionSources())).toEqual([]);
  });

  it("holds for every production file under server/, and the list is not stale", () => {
    const files = productionSources();
    expect(serverImportProblems(files)).toEqual([]);
    const without = new Map(files);
    without.delete("server/app.ts");
    expect(serverImportProblems(without)).toEqual(["server/app.ts: listed, not found"]);
  });

  it("no production file imports the transitional server", () => {
    const files = productionSources();
    expect(appImporters(files)).toEqual([]);
    expect(
      appImporters(new Map([["server/server.ts", 'import { createApp } from "./app.ts";']])),
    ).toEqual(["server/server.ts"]);
    expect(appImporters(new Map([["server/http/x.ts", 'export * from "../app.ts";']]))).toEqual([
      "server/http/x.ts",
    ]);
  });

  it("step 8 is in the pipeline and createLayers gives the real layer", async () => {
    expect(PIPELINE_STEPS).toContain("operatorPolicy");
    const request = new IncomingMessage(new Socket());
    request.url = "/api/v1/ops/x";
    const response = new ServerResponse(request);
    expect(await createLayers({ expectedOrigin: null }).operatorPolicy(request, response)).toBe(
      "done",
    );
    expect(response.statusCode).toBe(401);
  });
});
