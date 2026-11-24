import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { toPosix } from "../../scripts/index.ts";

// Split out of fake-server.test.ts (ZEL-SRV-NESTABILNI): the walk of the
// import graph from server/server.ts is its own file, so the vitest shards
// fill evenly, and the files of the repository are read and parsed once
// (beforeAll) and shared by every case instead of once per case.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FAKE_DIR = fileURLToPath(new URL("./generated/fake-server/", import.meta.url));

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

// The repository on disk, read lazily and remembered: each folder is listed
// once, each file read once. The tree does not change while the tests run, so
// every case shares one disk (built in beforeAll) and only the overlay of a
// case differs.
function diskFiles(): Files {
  const listings = new Map<string, string[] | undefined>();
  const kinds = new Map<string, boolean>();
  const texts = new Map<string, string>();
  const found = new Map<string, string | undefined>();
  const list = (dir: string): string[] | undefined => {
    if (!listings.has(dir))
      listings.set(dir, statSync(dir).isDirectory() ? readdirSync(dir) : undefined);
    return listings.get(dir);
  };
  const isFile = (path: string): boolean => {
    if (!kinds.has(path)) kinds.set(path, statSync(path).isFile());
    return kinds.get(path) ?? false;
  };
  const onDisk = (path: string): string | undefined => {
    const rel = relative(REPO_ROOT, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    let current = REPO_ROOT;
    for (const segment of rel.split(sep).filter(Boolean)) {
      const match = list(current)?.find((n) => n.toLowerCase() === segment.toLowerCase());
      if (match === undefined) return undefined;
      current = join(current, match);
    }
    return isFile(current) ? current : undefined;
  };
  const find = (path: string): string | undefined => {
    const key = path.toLowerCase();
    if (!found.has(key)) found.set(key, onDisk(path));
    return found.get(key);
  };
  return {
    read: (path) => {
      const at = find(path);
      if (at === undefined) return undefined;
      if (!texts.has(at)) texts.set(at, readFileSync(at, "utf8"));
      return texts.get(at);
    },
    find,
  };
}

// The shared disk of this file, set in beforeAll.
let disk: Files | undefined;
const sharedDisk = (): Files => (disk ??= diskFiles());

// The repository on disk, with `overlay` (repository paths to text) on top.
function repoFiles(overlay: Record<string, string> = {}): Files {
  const virtual = new Map(
    Object.entries(overlay).map(([path, text]) => [join(REPO_ROOT, path).toLowerCase(), text]),
  );
  const below = sharedDisk();
  return {
    read: (path) => virtual.get(path.toLowerCase()) ?? below.read(path),
    find: (path) => (virtual.has(path.toLowerCase()) ? path : below.find(path)),
  };
}

// The specifiers and path strings of a file, by file and text: a text read
// once is parsed once, and an overlay with another text is parsed anew.
const parsedFiles = new Map<string, { text: string; specs: string[] }>();
function specsOf(file: string, text: string): string[] {
  const known = parsedFiles.get(file);
  if (known?.text === text) return known.specs;
  const specs = [...moduleSpecifiers(file, text), ...pathStrings(file, text)];
  if (known === undefined) parsedFiles.set(file, { text, specs });
  return specs;
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
    for (const spec of specsOf(file, text)) {
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
  // The graph of the production entry point, walked once over the shared
  // disk; each case below walks it again with one line changed, reading and
  // parsing only what that line adds.
  let production: string[] = [];
  beforeAll(() => {
    disk = diskFiles();
    production = reachable(repoFiles(), "server/server.ts");
  });

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
    expect(production).toContain("server/http/start.ts");
    expect(testOnly(production)).toEqual([]);
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
