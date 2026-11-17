import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { isOpsPath } from "../traffic/index.ts";

// S-1J.2 (DAN-842-2; contract Ductus#1836 c.6947215068): no operator route reaches its
// handler without step 8 of the pipeline (operatorPolicy). The modules are
// those server/server.ts imports, directly or not (what `pnpm build` packs
// into dist/server.js), parsed with the TypeScript compiler, so comments,
// line breaks and quote style do not matter. Packages are not followed.
// Only start.ts serves HTTP and builds the pipeline, only server.ts starts the
// server and builds its layers with createLayers (without a second factor
// port until DAN-842-4), and only pipeline.ts names the step. An operator route lives under /api/v1/ops, the paths isOpsPath
// (and so steps 3 and 8) cover.
const REPO = process.cwd();
const ENTRY = "server/server.ts";
const START = "server/http/start.ts";
const PIPELINE = "server/http/pipeline.ts";
const NET = /^(?:node:)?(?:http|https|http2|net|tls|cluster|worker_threads|child_process)$/u;
/** What a module other than start.ts may take from the modules NET names. */
const SAFE = new Set(["STATUS_CODES", "METHODS", "isIP", "isIPv4", "isIPv6"]);
const SERVING = new Set(["createServer", "createSecureServer", "listen"]);
const OPERATOR_SEGMENT = /^(?:ops|operators?)$/iu;
/** Names a module may not import under another name: the checks read names. */
const GUARDED = new Set(["startServer", "createPipeline", "createLayers", "createServer"]);
const LISTENING = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

const posix = (path: string) => path.replaceAll("\\", "/");

/** The name a call or `new` names: `f(...)` and `a.f(...)` both give "f". */
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** Whether a static import takes a value (not only types) from a networking module. */
function takesServing(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false; // `import "node:http"` binds nothing
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((e) => !e.isTypeOnly && !SAFE.has((e.propertyName ?? e.name).text));
}

/** A path that names an operator but lies outside the paths step 8 covers. */
const stray = (path: string): boolean =>
  path.split(/[/?#]/u).some((s) => OPERATOR_SEGMENT.test(s)) && !isOpsPath(path);
const strayOperatorPaths = (paths: readonly string[]): string[] => paths.filter(stray);

/** Every way the text of `file` (relative to the repository) could bypass step 8. */
function bypasses(file: string, text: string): { found: string[]; imports: string[] } {
  const found: string[] = [];
  const imports: string[] = [];
  const layerNames = new Set<string>();
  const startCalls: ts.CallExpression[] = [];
  let servers = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      imports.push(specifier);
      const serving = ts.isImportDeclaration(node)
        ? takesServing(node.importClause)
        : !node.isTypeOnly;
      if (NET.test(specifier) && serving && file !== START) found.push(`imports ${specifier}`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      if (argument === undefined || !ts.isStringLiteralLike(argument)) {
        found.push("loads a module named at run time");
      } else {
        imports.push(argument.text);
        if (NET.test(argument.text) && file !== START) found.push(`loads ${argument.text}`);
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (file === START && (name === "createServer" || name === "createSecureServer")) servers++;
      const [first] = node.arguments ?? [];
      if (name !== undefined && LISTENING.has(name) && first !== undefined) {
        if (ts.isStringLiteralLike(first) && first.text === "request")
          found.push("listens to request");
      }
      if (ts.isCallExpression(node) && name === "createLayers") {
        const [options] = node.arguments;
        const plain =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.every(
            (p) => !ts.isSpreadAssignment(p) && p.name?.getText() !== "secondFactor",
          );
        // The second factor port comes with its source (DAN-842-4); until then none is handed over.
        if (file !== ENTRY || !plain) found.push("builds layers outside server.ts or with a port");
      }
      if (file !== START && name !== undefined) {
        if (ts.isNewExpression(node) ? name.endsWith("Server") : SERVING.has(name)) {
          found.push(`serves through ${name}`);
        }
        if (name === "createPipeline") found.push("builds a pipeline");
      }
      if (ts.isCallExpression(node) && name === "startServer") startCalls.push(node);
    } else if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === "operatorPolicy" &&
      file !== PIPELINE
    ) {
      found.push("names operatorPolicy");
    } else if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      node.propertyName !== undefined &&
      GUARDED.has(node.propertyName.text) &&
      node.propertyName.text !== node.name.text
    ) {
      found.push(`renames ${node.propertyName.text}`);
    }
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/") && stray(node.text)) {
      found.push(`operator path outside /api/v1/ops: ${node.text}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      calleeName(node.initializer.expression) === "createLayers"
    ) {
      layerNames.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  for (const call of startCalls) {
    const [options] = call.arguments;
    const layers =
      options !== undefined && ts.isObjectLiteralExpression(options)
        ? options.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText() === "layers",
          )?.initializer
        : undefined;
    const fromCreateLayers =
      layers !== undefined &&
      ((ts.isIdentifier(layers) && layerNames.has(layers.text)) ||
        (ts.isCallExpression(layers) && calleeName(layers.expression) === "createLayers"));
    if (file !== ENTRY || !fromCreateLayers) found.push("starts a server without createLayers");
  }
  if (file === START && servers !== 1) found.push(`creates ${servers} servers`);
  return { found, imports };
}

/** The repository module a relative specifier names, or null for a package or builtin. */
function resolveModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(REPO, dirname(file), specifier);
  for (const path of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (/\.ts$/u.test(path) && existsSync(path)) return posix(relative(REPO, path));
  }
  throw new Error(`${file}: cannot resolve ${specifier}`);
}

/** Every module server.ts reaches, with what each was found doing. */
function scanGraph(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [ENTRY];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    const { found, imports } = bypasses(file, readFileSync(join(REPO, file), "utf8"));
    seen.set(file, found);
    for (const specifier of imports) {
      const next = resolveModule(file, specifier);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const F = "server/http/fixture.ts";

describe("bypasses (negative cases first)", () => {
  it.each([
    'import { createServer } from "node:http"; createServer(h);',
    'import http from "http"; http.createServer(h);',
    'import * as https from "node:https";',
    'import { Server } from "node:net"; new Server(h);',
    "new net.Server(h);",
    "http2.createSecureServer(o);",
    "app.listen(8080);",
    'require("node:http");',
    'const m = await import("node:http2");',
    'export { createServer } from "node:http";',
    "import {\r\n\tcreateServer\r\n} from\t'node:http';",
    'import { Worker } from "node:worker_threads";',
    'import { fork } from "child_process";',
    'server.on("request", router);',
    "server.addListener('request', router);",
  ])("a second server outside start.ts: %j", (text) => {
    expect(bypasses(F, text).found).not.toEqual([]);
  });

  it.each([
    "const l = { ...createLayers(o), operatorPolicy: pass };",
    'const l = { ["operatorPolicy"]: pass };',
    "layers.operatorPolicy(request, response);",
    "createPipeline(layers, app);",
    "const m = await import(name);",
    "require(`./${name}.ts`);",
    'import { startServer as s } from "./start.ts";',
    'export { createPipeline as build } from "./pipeline.ts";',
    'const route = { path: "/api/v1/operators/x" };',
    'const route = { path: "/api/v2/ops" };',
    "createLayers({ expectedOrigin: null });",
  ])("a pipeline without step 8: %j", (text) => {
    expect(bypasses(F, text).found).not.toEqual([]);
  });

  it.each([
    "startServer({ layers: hand });",
    "const L = createLayers(o); startServer({ layers: { ...L } });",
    "startServer(options);",
    "startServer({ ...o });",
  ])("server.ts starts without the layers of createLayers: %j", (text) => {
    expect(bypasses(ENTRY, text).found).toContain("starts a server without createLayers");
  });

  it.each([
    'createLayers({ expectedOrigin: o, secondFactor: async () => "confirmed" });',
    "createLayers({ ...o });",
    "createLayers(o);",
  ])("server.ts builds layers with a port or unread options: %j", (text) => {
    expect(bypasses(ENTRY, text).found).toContain("builds layers outside server.ts or with a port");
  });

  it.each([
    "const none = 1;",
    "const a = createServer(h); const b = createServer(h);",
    "const a = createServer(h); a.on('request', other);",
  ])("start.ts with other than one server or a second handler: %j", (text) => {
    expect(bypasses(START, text).found).not.toEqual([]);
  });

  it("startServer outside server.ts", () => {
    const text = "const L = createLayers(o); startServer({ layers: L });";
    expect(bypasses(F, text).found).toContain("starts a server without createLayers");
  });

  it("an operator route outside /api/v1/ops", () => {
    const paths = ["/api/v2/ops/x", "/api/v1/admin/Operators/x", "/ops/x", "/api/v1/OPERATOR"];
    expect(strayOperatorPaths(paths)).toEqual(paths);
  });

  it.each([
    'import type { IncomingMessage } from "node:http";',
    'import { type ServerResponse, STATUS_CODES } from "node:http";',
    'import { isIPv6 } from "node:net";',
    "createServerErrorReporter(log);",
    "// operatorPolicy, createServer(h)",
    "const L = createLayers({ expectedOrigin: o }); startServer({ layers: L });",
  ])("no false finding: %j", (text) => {
    const file = text.includes("startServer") ? ENTRY : F;
    expect(bypasses(file, text).found).toEqual([]);
  });

  it("an operator path under /api/v1/ops is no stray", () => {
    const paths = ["/api/v1/ops/operators", "/API/V1/OPS", "/api/v1/opsx", "/api/v1/health"];
    expect(strayOperatorPaths(paths)).toEqual([]);
  });
});

describe("the server as built", () => {
  const graph = scanGraph();

  it("reaches the pipeline, its step 8 and the start", () => {
    for (const file of [START, PIPELINE, "server/http/operator-policy-layer.ts"]) {
      expect(graph.has(file)).toBe(true);
    }
  });

  it("no module serves, builds a pipeline or names step 8 but the ones allowed", () => {
    const found = [...graph].filter(([, list]) => list.length > 0);
    expect(Object.fromEntries(found)).toEqual({});
  });

  it("every contract path that names an operator is under /api/v1/ops", () => {
    expect(strayOperatorPaths(ROUTES.map((route) => route.path))).toEqual([]);
  });
});
