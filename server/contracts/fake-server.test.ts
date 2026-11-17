import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { toPosix } from "../../scripts/index.ts";
import {
  answerFake,
  FAKE_VECTOR_HEADER,
  ROUTE_TABLE,
  VECTORS,
  type FakeVector,
  type FakeRequest,
} from "./generated/fake-server/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FAKE_DIR = fileURLToPath(new URL("./generated/fake-server/", import.meta.url));
const COOKIE = "__Host-ductus_session=izmisljeni_token-jezika_sucelja_00000000001";
const SAME_ORIGIN = {
  cookie: COOKIE,
  origin: "https://ductura.example.invalid",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

/** The request a vector describes, as a client would send it. */
function requestOf(v: FakeVector, pick = true): FakeRequest {
  const route = ROUTE_TABLE[v.route as keyof typeof ROUTE_TABLE];
  const params = v.request.params ?? {};
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const query = new URLSearchParams(v.request.query ?? {}).toString();
  const { body, rawBody } = v.request;
  const text =
    rawBody ??
    (body === undefined
      ? ""
      : route.body === "application/x-www-form-urlencoded"
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(v.request.headers ?? {}))
    headers[name.toLowerCase()] = value;
  if (pick) headers[FAKE_VECTOR_HEADER] = v.name;
  return {
    method: route.method,
    url: query ? `${path}?${query}` : path,
    headers,
    body: new TextEncoder().encode(text),
  };
}

/** What the vector says the answer is, written out independently of the fake server. */
function expected(v: FakeVector) {
  const { status, contentType, headers = {}, body } = v.response;
  return {
    status,
    headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
    body: body === undefined ? "" : contentType === "application/json" ? body : (body as string),
  };
}

function parsed(answer: ReturnType<typeof answerFake>) {
  const json = answer.headers["content-type"] === "application/json";
  return { ...answer, body: json ? (JSON.parse(answer.body) as unknown) : answer.body };
}

const named = (route: string, name: string): FakeVector => {
  const v = VECTORS.find((x) => x.route === route && x.name === name);
  if (!v) throw new Error(`no vector ${route}/${name}`);
  return v;
};

describe("fake server answers with the vectors", () => {
  it("embeds every vector of every route", () => {
    expect(new Set(VECTORS.map((v) => v.route))).toEqual(new Set(Object.keys(ROUTE_TABLE)));
    expect(VECTORS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(VECTORS.map((v) => [`${v.route} ${v.name}`, v] as const))(
    "%s: the named vector's request gets exactly its answer",
    (_, v) => {
      expect(parsed(answerFake(requestOf(v)))).toEqual(expected(v));
    },
  );

  it.each([
    ["platform.health.get", "alive", "alive"],
    ["profile.interface-locale.post", "saved", "saved"],
    ["profile.interface-locale.post", "unauthorized", "unauthorized"],
    ["profile.interface-locale.post", "invalid-input", "invalid-input"],
    ["profile.interface-locale.post", "origin-missing", "origin-missing"],
    ["profile.interface-locale.post", "unavailable", "saved"],
    ["auth.backchannel-logout.post", "sessions-closed", "sessions-closed"],
  ])("%s %s without a pick gets the first matching vector, %s", (route, name, first) => {
    const answer = parsed(answerFake(requestOf(named(route, name), false)));
    expect(answer).toEqual(expected(named(route, first)));
  });

  it("reads the caller's header names whatever their case, the pick among them", () => {
    const logout = requestOf(named("auth.backchannel-logout.post", "sessions-closed"), false);
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    expect(answerFake({ ...logout, headers }).status).toBe(200);
    const unavailable = named("auth.backchannel-logout.post", "unavailable");
    const picked = { ...headers, "X-Ductura-Fake-Vector": "unavailable" };
    expect(parsed(answerFake({ ...logout, headers: picked }))).toEqual(expected(unavailable));
  });

  it("matches JSON bodies whatever the key order and headers whatever their case", () => {
    const v = named("profile.interface-locale.post", "saved");
    const req = requestOf(v);
    const headers = { ...req.headers, "X-Extra": "izmisljeno" };
    expect(answerFake({ ...req, headers }).status).toBe(200);
  });
});

describe("a request without a vector answers 501", () => {
  const notImplemented = {
    status: 501,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: { error: "not_implemented" },
  };
  const post = (body: string, headers: Record<string, string> = SAME_ORIGIN): FakeRequest => ({
    method: "POST",
    url: "/api/v1/profile/interface-locale",
    headers,
    body: new TextEncoder().encode(body),
  });
  const get = (url: string, headers: Record<string, string> = {}): FakeRequest => ({
    method: "GET",
    url,
    headers,
    body: new Uint8Array(),
  });

  it.each([
    ["a query no vector has", get("/api/v1/health?x=1")],
    ["a repeated query field", get("/api/v1/health?x=1&x=2")],
    ["a query field named __proto__", get("/api/v1/health?__proto__=x")],
    ["a repeated query field named __proto__", get("/api/v1/health?__proto__=x&__proto__=y")],
    [
      "a form field named __proto__ next to a vector's fields",
      {
        method: "POST",
        url: "/api/v1/auth/backchannel-logout",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode("logout_token=izmisljeni.logout.token&__proto__=x"),
      },
    ],
    ["a body no vector has", post('{"locale":"fr"}')],
    ["a body that is not JSON", post("{")],
    ["a body that is not UTF-8", { ...post(""), body: new Uint8Array([0xff, 0xfe]) }],
    ["a body where the vector has none", { ...get("/api/v1/health"), body: new Uint8Array([1]) }],
    ["an unknown vector name", get("/api/v1/health", { [FAKE_VECTOR_HEADER]: "nema-ga" })],
    [
      "a named vector whose request does not match",
      post('{"locale":"en"}', { ...SAME_ORIGIN, cookie: "x=y", [FAKE_VECTOR_HEADER]: "saved" }),
    ],
    [
      "a vector of another route",
      get("/api/v1/health", { [FAKE_VECTOR_HEADER]: "session-opened" }),
    ],
  ])("%s", (_, req) => {
    expect(parsed(answerFake(req))).toEqual(notImplemented);
  });

  it("keeps 405 for another method and the fallback 404 for an unknown path", () => {
    expect(answerFake({ ...post(""), method: "PUT" })).toMatchObject({
      status: 405,
      headers: { allow: "GET, POST" },
    });
    expect(answerFake(get("/api/v1/nope")).status).toBe(404);
  });
});

// Every module a file names, in any form: import and `import type`,
// `export … from`, `import x = require(…)`, `typeof import(…)`, a
// `/// <reference>` comment, and the string first argument of a loader call:
// import(), require, module.require, require.resolve, a createRequire result
// and import.meta.resolve. `as`, `satisfies`, `!` and parentheses around
// the string are seen through.
function moduleSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [...source.referencedFiles, ...source.typeReferenceDirectives].map(
    (reference) => reference.fileName,
  );
  const literal = (node: ts.Node | undefined): string | undefined => {
    let inner = node;
    while (
      inner &&
      (ts.isAsExpression(inner) ||
        ts.isTypeAssertionExpression(inner) ||
        ts.isSatisfiesExpression(inner) ||
        ts.isNonNullExpression(inner) ||
        ts.isParenthesizedExpression(inner))
    ) {
      inner = inner.expression;
    }
    return inner && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))
      ? inner.text
      : undefined;
  };
  // import(), require, x.require, x.resolve, and the call of a call (createRequire(…)(…)).
  const isLoader = (callee: ts.Expression): boolean =>
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require") ||
    (ts.isPropertyAccessExpression(callee) && ["require", "resolve"].includes(callee.name.text)) ||
    ts.isCallExpression(callee);
  const visit = (node: ts.Node): void => {
    let spec: string | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      spec = literal(node.moduleSpecifier);
    else if (ts.isExternalModuleReference(node)) spec = literal(node.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      spec = literal(node.argument.literal);
    else if (ts.isCallExpression(node) && isLoader(node.expression))
      spec = literal(node.arguments[0]);
    if (spec !== undefined) found.push(spec);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Every string in a file that reads as a path (./, ../, /, file:), wherever
// it stands: a module loaded through a variable or an alias of require is
// still followed, at the cost of following a path that is only data.
function pathStrings(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^(?:\.\.?(?:[/\\]|$)|[/\\]|file:)/iu.test(node.text.trim())
    )
      found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

type Files = {
  /** The text of a file, or undefined when it is not there. */
  read: (path: string) => string | undefined;
  /** The file at path, matched in any letter case as Windows and macOS do. */
  find: (path: string) => string | undefined;
};

// The repository on disk, with `overlay` (repository paths to text) on top.
function repoFiles(overlay: Record<string, string> = {}): Files {
  const virtual = new Map(
    Object.entries(overlay).map(([path, text]) => [join(REPO_ROOT, path).toLowerCase(), text]),
  );
  const onDisk = (path: string): string | undefined => {
    const rel = relative(REPO_ROOT, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    let current = REPO_ROOT;
    for (const segment of rel.split(sep).filter(Boolean)) {
      if (!statSync(current).isDirectory()) return undefined;
      const match = readdirSync(current).find((n) => n.toLowerCase() === segment.toLowerCase());
      if (match === undefined) return undefined;
      current = join(current, match);
    }
    return statSync(current).isFile() ? current : undefined;
  };
  return {
    read: (path) =>
      virtual.get(path.toLowerCase()) ?? (onDisk(path) ? readFileSync(path, "utf8") : undefined),
    find: (path) => (virtual.has(path.toLowerCase()) ? path : onDisk(path)),
  };
}

// The file a specifier loads from `from`, as Node and TypeScript resolve a
// path: either slash, a query or fragment cut off, %-escapes decoded, a file:
// URL, and for a .js name, no extension or a folder its .ts file or index.ts.
// A package or node: builtin gives undefined.
function resolveModule(files: Files, from: string, specifier: string): string | undefined {
  const text = specifier
    .trim()
    .replace(/\\/g, "/")
    .replace(/[?#].*$/su, "");
  let path: string;
  try {
    if (/^file:/iu.test(text)) path = fileURLToPath(text);
    else {
      const decoded = decodeURIComponent(text);
      if (/^\.\.?(?:\/|$)/u.test(decoded)) path = resolve(dirname(from), decoded);
      else if (isAbsolute(decoded)) path = resolve(decoded);
      else return undefined;
    }
  } catch {
    return undefined;
  }
  const ts = path.replace(/\.([cm]?)js$/iu, ".$1ts");
  for (const candidate of [path, ts, `${path}.ts`, join(path, "index.ts")]) {
    const found = files.find(candidate);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every file reachable from `entry`, as repository paths. */
function reachable(files: Files, entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?ts$/iu.test(file)) continue;
    const text = files.read(file) ?? "";
    for (const spec of [...moduleSpecifiers(file, text), ...pathStrings(file, text)]) {
      const next = resolveModule(files, file, spec);
      if (next !== undefined) queue.push(next);
    }
  }
  return [...seen].map((f) => toPosix(relative(REPO_ROOT, f)));
}

// The fake server and the test code that may re-export it (TEST_ONLY_FILES in
// eslint.config.ts), in any letter case.
const testOnly = (paths: string[]): string[] =>
  paths.filter((f) =>
    /(?:^|\/)generated\/fake-server\/|^(?:test-support|server\/test-server|packages\/test-fakes)\/|\.test\.[cm]?[jt]s$/iu.test(
      f,
    ),
  );

describe("the fake server stays out of production", () => {
  const specifiers = (file: string): string[] => moduleSpecifiers(file, readFileSync(file, "utf8"));

  it("imports only node:http and node:fs, so U9 can move the folder as it is", () => {
    expect(readdirSync(FAKE_DIR).sort()).toEqual(["index.ts", "vectors.json"]);
    expect(specifiers(join(FAKE_DIR, "index.ts")).sort()).toEqual(["node:fs", "node:http"]);
    // The one file it reads is its sibling vectors.json.
    const reads = [
      ...readFileSync(join(FAKE_DIR, "index.ts"), "utf8").matchAll(/new URL\("([^"]+)"/g),
    ];
    expect(reads.map((m) => m[1])).toEqual(["./vectors.json"]);
  });

  it("is not reachable from the production entry point server/server.ts", () => {
    const reached = reachable(repoFiles(), "server/server.ts");
    expect(reached).toContain("server/http/start.ts");
    expect(testOnly(reached)).toEqual([]);
  });

  // QA on e34b91f6 (c.6886570274): the walk sees every form and spelling. Each
  // case puts one line into server/server.ts over the files on disk.
  const FAKE = "./contracts/generated/fake-server/index.ts";
  const ENTRY = "server/server.ts";
  // A `/// <reference>` counts only at the top of a file, so it goes first.
  const withEntry = (line: string): string[] => {
    const entry = readFileSync(join(REPO_ROOT, ENTRY), "utf8");
    const text = line.startsWith("///") ? `${line}\n${entry}` : `${entry}\n${line}\n`;
    return reachable(repoFiles({ [ENTRY]: text }), ENTRY);
  };

  it.each([
    ["import x = require", `import fake = require("${FAKE}");`, true],
    ["export import x = require", `export import fake = require("${FAKE}");`, true],
    ["import", `import { createFakeServer } from "${FAKE}";`, true],
    ["import of the side effects", `import "${FAKE}";`, true],
    ["import type", `import type { FakeRequest } from "${FAKE}";`, true],
    ["export from", `export { createFakeServer } from "${FAKE}";`, true],
    ["export type from", `export type { FakeRequest } from "${FAKE}";`, true],
    ["export * as", `export * as fake from "${FAKE}";`, true],
    ["import()", `export const load = () => import("${FAKE}");`, true],
    ["import() with as", `export const load = () => import(("${FAKE}") as string);`, true],
    ["typeof import()", `export type X = typeof import("${FAKE}");`, true],
    ["require", `export const x: unknown = require("${FAKE}");`, true],
    ["createRequire", `export const x: unknown = createRequire(import.meta.url)("${FAKE}");`, true],
    [
      "an alias of require",
      `const load = require;\nexport const x: unknown = load("${FAKE}");`,
      false,
    ],
    [
      "a specifier in a variable",
      `const at = "${FAKE}";\nexport const load = () => import(at);`,
      false,
    ],
    ["/// <reference path>", `/// <reference path="${FAKE}" />`, true],
    [".js", `import fake = require("./contracts/generated/fake-server/index.js");`, true],
    ["no extension", `import fake = require("./contracts/generated/fake-server/index");`, true],
    ["the folder", `import fake = require("./contracts/generated/fake-server");`, true],
    [
      "another letter case",
      `import fake = require("./Contracts/Generated/Fake-Server/index.ts");`,
      true,
    ],
    ["%-escapes", `import fake = require("./contracts/generated/fake%2Dserver/index.ts");`, true],
    [
      "backslashes",
      `import fake = require(".\\\\contracts\\\\generated\\\\fake-server\\\\index.ts");`,
      true,
    ],
    ["a query", `export const load = () => import("${FAKE}?v=1");`, true],
    ["vectors.json", `export const at = "./contracts/generated/fake-server/vectors.json";`, false],
  ])("finds the fake server imported by %s", (_, line, form) => {
    expect(testOnly(withEntry(line))).not.toEqual([]);
    // A module form is read as one, not only found as a string that reads as a path.
    if (form) expect(moduleSpecifiers(ENTRY, line).join()).toMatch(/fake(?:-|%2D)server/iu);
  });

  it("finds it re-exported through a production helper or through test code", () => {
    const helper = "server/contracts/helper.ts";
    const files = repoFiles({
      [ENTRY]: `export * from "./contracts/helper.ts";\n`,
      [helper]: `export * from "./generated/fake-server/index.ts";\n`,
    });
    expect(testOnly(reachable(files, ENTRY))).toContain(
      "server/contracts/generated/fake-server/index.ts",
    );
    for (const spec of ["./test-server/index.ts", "../test-support/x/index.ts", "./a.test.ts"]) {
      const viaTest = repoFiles({
        [ENTRY]: `import x = require("${spec}");\n`,
        [toPosix(relative(REPO_ROOT, resolve(REPO_ROOT, "server", spec)))]:
          `export * from "${FAKE}";\n`,
      });
      expect(testOnly(reachable(viaTest, ENTRY))).not.toEqual([]);
    }
  });

  it("is not exported from generated/index.ts", () => {
    const index = readFileSync(join(FAKE_DIR, "..", "index.ts"), "utf8");
    expect(index).not.toContain("fake-server");
  });
});
