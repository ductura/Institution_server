import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// U9 (DAN-741), D-09: @ductura/test-fakes never reaches production. Until
// dist/server.js exists (S-1B-a), the production build is (a) the production
// dependency closure of the root package and (b) every module that production
// code under server/ loads.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGE_DIR = join(REPO_ROOT, "packages", "test-fakes");
const NAME = "@ductura/test-fakes";

type ListNode = { readonly dependencies?: Readonly<Record<string, ListNode>> };

/**
 * Every package name in a `pnpm list --json` dependency tree. Every subtree is
 * walked, even under a name already seen: two versions of one package can
 * depend on different packages (review c.6887461155). Parsed JSON has no
 * cycles, so the walk ends; only the result is deduplicated.
 */
export function closureNames(tree: readonly ListNode[]): Set<string> {
  const names = new Set<string>();
  const stack: ListNode[] = [...tree];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      names.add(name);
      stack.push(child);
    }
  }
  return names;
}

const TEST_FILE = /\.test\.[cm]?ts$/u;

function productionRoots(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.[cm]?ts$/u.test(name) && !TEST_FILE.test(name)) out.push(path);
    }
  };
  walk(join(REPO_ROOT, "server"));
  return out;
}

/**
 * The repository files TypeScript loads from `roots` with the repository's
 * module resolution (static imports, export from, literal import() and
 * require), packages followed through node_modules to their real path.
 * `overlay` replaces or adds files by absolute path.
 */
export function loadedFiles(
  roots: readonly string[],
  overlay: Readonly<Record<string, string>> = {},
): string[] {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    allowJs: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (path) => path in overlay || fileExists(path);
  host.readFile = (path) => overlay[path] ?? readFile(path);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, ...rest) =>
    path in overlay
      ? ts.createSourceFile(path, overlay[path] ?? "", language)
      : getSourceFile(path, language, ...rest);
  const program = ts.createProgram([...roots, ...Object.keys(overlay)], options, host);
  return program
    .getSourceFiles()
    .map((file) => relative(REPO_ROOT, resolve(file.fileName)).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("..") && !path.startsWith("node_modules/"));
}

const reachesFakes = (files: readonly string[]): string[] =>
  files.filter((path) => /^packages\/test-fakes\//iu.test(path));
// S-1F-e (DAN-785): test-support/ (test databases among it) is test code too.
const reachesTestSupport = (files: readonly string[]): string[] =>
  files.filter((path) => /^test-support\//iu.test(path));

// U9-b: PGlite is a dependency of the package only. A production file that
// names it directly is caught here even when pnpm leaves it unresolvable.
const PGLITE = "@electric-sql/pglite";
const namesPglite = (code: string): boolean =>
  ts
    .preProcessFile(code, true, true)
    .importedFiles.some(({ fileName }) => fileName === PGLITE || fileName.startsWith(`${PGLITE}/`));

describe("@ductura/test-fakes stays out of production", () => {
  it("is only a devDependency of the root, and private", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(root.devDependencies?.[NAME]).toBe("workspace:*");
    for (const field of [root.dependencies, root.optionalDependencies, root.peerDependencies]) {
      expect(Object.keys(field ?? {})).not.toContain(NAME);
    }
    const own = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      private?: boolean;
    };
    expect(own.private).toBe(true);
  });

  it("is not in the production dependency closure, nor are its own dependencies", () => {
    const out = execFileSync(
      "pnpm",
      ["list", "--prod", "--json", "--depth", "Infinity", "--filter", "@ductura/server"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const names = closureNames(JSON.parse(out) as ListNode[]);
    expect(names.size).toBeGreaterThan(0);
    expect(names).not.toContain(NAME);
    expect(names).not.toContain("oidc-provider");
    expect(names).not.toContain(PGLITE);
  });

  it("closureNames finds the package at any depth (the check can fail)", () => {
    const tree: ListNode[] = [
      { dependencies: { pg: { dependencies: { [NAME]: { dependencies: { x: {} } } } } } },
    ];
    expect([...closureNames(tree)].sort()).toEqual([NAME, "pg", "x"].sort());
  });

  it("closureNames walks a repeated name with a different subtree", () => {
    // a -> shared@1, b -> shared@2 -> oidc-provider: the second shared counts.
    const tree: ListNode[] = [
      {
        dependencies: {
          a: { dependencies: { shared: {} } },
          b: { dependencies: { shared: { dependencies: { "oidc-provider": {} } } } },
        },
      },
    ];
    expect(closureNames(tree)).toContain("oidc-provider");
  });

  it("no production file under server/ loads it", () => {
    const roots = productionRoots();
    expect(roots).toContain(join(REPO_ROOT, "server", "server.ts"));
    const loaded = loadedFiles(roots);
    expect(loaded).toContain("server/app.ts");
    expect(loaded).toContain("server/http/start.ts");
    expect(reachesFakes(loaded)).toEqual([]);
    expect(reachesTestSupport(loaded)).toEqual([]);
  });

  it.each([
    `export { createTestDatabase } from "../test-support/database/index.ts";
`,
    `export const load = () => import("../test-support/database/postgres.ts");
`,
    `export * from "../test-support/database/exceptions.ts";
`,
  ])("the walk sees a production file that loads test-support: %s", (code) => {
    const probe = join(REPO_ROOT, "server", "boundary-probe.ts");
    const loaded = loadedFiles([probe], { [probe]: code });
    expect(reachesTestSupport(loaded)).not.toEqual([]);
  });

  it.each([
    `import * as fakes from "${NAME}";\nexport const x = fakes;\n`,
    `export { createFakeClock } from "${NAME}/clock";\n`,
    `export const load = () => import("${NAME}/oidc");\n`,
    `export * from "../packages/test-fakes/index.ts";\n`,
    `export { createPgliteDatabase } from "${NAME}/pglite";\n`,
    `export const load = () => import("../packages/test-fakes/pglite/database.ts");\n`,
  ])("the walk sees a production file that loads it: %s", (code) => {
    const probe = join(REPO_ROOT, "server", "boundary-probe.ts");
    expect(reachesFakes(loadedFiles([probe], { [probe]: code }))).not.toEqual([]);
  });

  it("no production file under server/ names PGlite", () => {
    const named = productionRoots().filter((path) => namesPglite(readFileSync(path, "utf8")));
    expect(named).toEqual([]);
  });

  it.each([
    `import { PGlite } from "${PGLITE}";\nexport const x = PGlite;\n`,
    `export const load = () => import("${PGLITE}/contrib/pgcrypto");\n`,
    `const { PGlite } = require("${PGLITE}");\n`,
  ])("the PGlite check sees %s", (code) => {
    expect(namesPglite(code)).toBe(true);
  });

  it("the old fake OIDC folder under test-support is gone and nothing names it", () => {
    const old = ["test-support", "fake-oidc"].join("/");
    expect(existsSync(join(REPO_ROOT, old))).toBe(false);
    const named: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".git")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(?:[cm]?ts|json|ya?ml)$/u.test(name) &&
          readFileSync(path, "utf8").includes(old)
        )
          named.push(relative(REPO_ROOT, path));
      }
    };
    for (const dir of ["server", "scripts", "tests", "test-support", "packages", "db", "infra"])
      walk(join(REPO_ROOT, dir));
    expect(named).toEqual([]);
  });
});
