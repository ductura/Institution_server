import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { TEST_ONLY_PACKAGES } from "./manifest.ts";

// U10-b (DAN-742): @ductura/test-fakes is not a dependency of the production
// build. Until dist/server.js (S-1H.3), that build is the "dependencies" of the
// root package.json, so neither they nor anything they pull in through
// pnpm-lock.yaml may reach a test-only package or a workspace link.
const ROOT = resolve(import.meta.dirname, "../..");
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const LOCK = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");

type Deps = Record<string, string | { version: string }> | undefined;
type Lock = {
  importers?: Record<string, { dependencies?: Deps; optionalDependencies?: Deps }>;
  snapshots?: Record<string, { dependencies?: Deps; optionalDependencies?: Deps } | null>;
};

/** name@version of a lockfile dependency; an alias (`npm:x@1`) is its real package. */
function resolveDep(name: string, entry: string | { version: string }): string {
  const version = typeof entry === "string" ? entry : entry.version;
  return /^(?:@[^@/]+\/)?[^@/:]+@/u.test(version) ? version : `${name}@${version}`;
}

/** name@version of every package the root `dependencies` install, transitively. */
export function productionClosure(text: string): string[] {
  const lock = parse(text) as Lock;
  const deps = (from?: { dependencies?: Deps; optionalDependencies?: Deps } | null) =>
    [from?.dependencies, from?.optionalDependencies].flatMap((group) =>
      Object.entries(group ?? {}).map(([name, entry]) => resolveDep(name, entry)),
    );
  const seen = new Set<string>();
  const queue = deps(lock.importers?.["."]);
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...deps(lock.snapshots?.[next]));
  }
  return [...seen].sort();
}

/** Every test-only package or workspace or file link in `closure`. */
const forbidden = (closure: readonly string[]) =>
  closure.filter(
    (entry) =>
      /@(?:link|file|workspace):/u.test(entry) ||
      TEST_ONLY_PACKAGES.some((name) => entry.startsWith(`${name}@`)),
  );

describe("the production build", () => {
  it("declares no test-only package in dependencies", () => {
    const names = Object.keys(MANIFEST.dependencies ?? {});
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => TEST_ONLY_PACKAGES.includes(name))).toEqual([]);
  });

  it("reaches no test-only package or workspace link through the lockfile", () => {
    const closure = productionClosure(LOCK);
    expect(closure).toContain("pg@8.23.1");
    expect(closure).toContain("@smithy/types@4.20.0"); // through @aws-sdk/client-kms
    expect(closure.length).toBeGreaterThan(Object.keys(MANIFEST.dependencies ?? {}).length);
    expect(forbidden(closure)).toEqual([]);
  });

  const lock = (dependency: string, snapshot = "") =>
    "importers:\n\n  .:\n    dependencies:\n      a:\n        specifier: 1.0.0\n        version: 1.0.0\n" +
    `${dependency}    devDependencies:\n      x:\n        specifier: 1.0.0\n        version: 1.0.0\n\n` +
    `snapshots:\n\n  a@1.0.0:${snapshot}\n\n  b@2.0.0:\n    dependencies:\n      oidc-provider: 9.12.2\n`;

  it.each([
    [
      "a direct workspace link",
      "      '@ductura/test-fakes':\n        specifier: workspace:*\n        version: link:packages/test-fakes\n",
    ],
    [
      "a direct test-only package",
      "      oidc-provider:\n        specifier: 9.12.2\n        version: 9.12.2\n",
    ],
  ])("refuses %s", (_, dependency) => {
    expect(forbidden(productionClosure(lock(dependency)))).not.toEqual([]);
  });

  it.each([
    [
      "an alias",
      "      fake:\n        specifier: npm:oidc-provider@9.12.2\n        version: oidc-provider@9.12.2\n",
    ],
    [
      "a file link",
      "      tf:\n        specifier: file:packages/test-fakes\n        version: file:packages/test-fakes\n",
    ],
  ])("refuses %s of a test-only package", (_, dependency) => {
    expect(forbidden(productionClosure(lock(dependency)))).not.toEqual([]);
  });

  it("follows optional dependencies of the root and aliases deeper down", () => {
    const optional = lock("").replace(
      "    devDependencies:",
      "    optionalDependencies:\n      b:\n        specifier: 2.0.0\n        version: 2.0.0\n    devDependencies:",
    );
    expect(forbidden(productionClosure(optional))).toEqual(["oidc-provider@9.12.2"]);
    const alias = lock("", "\n    dependencies:\n      y: oidc-provider@9.12.2");
    expect(forbidden(productionClosure(alias))).toEqual(["oidc-provider@9.12.2"]);
  });

  it("refuses a test-only package two steps away, and not one only a dev dependency reaches", () => {
    expect(forbidden(productionClosure(lock("")))).toEqual([]);
    const transitive = lock("", "\n    dependencies:\n      b: 2.0.0");
    expect(forbidden(productionClosure(transitive))).toEqual(["oidc-provider@9.12.2"]);
  });
});
