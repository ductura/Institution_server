// The validator of the entry point (S-1B-a, DAN-775): every area folder with a
// routes.ts is named in server/server.ts and in the registry of server/http,
// and nothing else is. An unknown name, a folder that is not named and an
// import past http, config and settings each fail.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AREA_NAMES } from "./http/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// test-server is its own composition root and nobody imports it
// (docs/server-map.md §2), so the production entry never mounts its routes.
const OWN_ENTRY = new Set(["test-server"]);
const ENTRY_IMPORTS = new Set(["./config/index.ts", "./http/index.ts", "./settings/index.ts"]);

/** Area keys (as in the server map) of the folders that have a routes.ts. */
function areasWithRoutes(root: string): string[] {
  const keys: string[] = [];
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(join(root, "server", prefix), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (key === "external") walk("external");
      else if (existsSync(join(root, "server", key, "routes.ts"))) keys.push(key);
    }
  };
  walk("");
  return keys.sort();
}

/** The names listed in `const AREAS` of the entry text. */
function namedAreas(entry: string): string[] {
  const list = /const AREAS[^=]*=\s*\[([^\]]*)\]/u.exec(entry)?.[1];
  if (list === undefined) throw new Error("server.ts has no AREAS list");
  // A commented-out name is not mounted, so it does not count.
  const code = list.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  return [...code.matchAll(/["']([^"']+)["']/gu)].map((m) => m[1] ?? "").sort();
}

/** What is wrong between the folders on disk, the entry and the http registry. */
function entryProblems(root: string, entry: string, registry: readonly string[]): string[] {
  const onDisk = areasWithRoutes(root).filter((key) => !OWN_ENTRY.has(key));
  const named = namedAreas(entry);
  return [
    ...named.filter((k, i) => named.indexOf(k) !== i).map((k) => `${k} named twice in AREAS`),
    ...onDisk.filter((k) => !named.includes(k)).map((k) => `server/${k} has routes, not in AREAS`),
    ...named.filter((k) => !onDisk.includes(k)).map((k) => `${k} in AREAS has no routes.ts`),
    ...onDisk.filter((k) => !registry.includes(k)).map((k) => `server/${k} not in http AREA_NAMES`),
    ...registry
      .filter((k) => !onDisk.includes(k))
      .map((k) => `${k} in AREA_NAMES has no routes.ts`),
  ];
}

const ENTRY_TEXT = readFileSync(join(ROOT, "server/server.ts"), "utf8");

describe("server/server.ts", () => {
  it("names every area with routes, and only those", () => {
    expect(areasWithRoutes(ROOT).length).toBeGreaterThan(0);
    expect(entryProblems(ROOT, ENTRY_TEXT, AREA_NAMES)).toEqual([]);
  });

  it("imports only http, config and settings, so no database connection of its own", () => {
    const imports = [
      ...ENTRY_TEXT.matchAll(/^\s*(?:import|export)\b[^;]*?["']([^"']+)["']\s*;/gmu),
    ];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.map((m) => m[1]).filter((spec) => !ENTRY_IMPORTS.has(spec ?? ""))).toEqual([]);
    expect(ENTRY_TEXT).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bpg\b|Pool\b/u);
  });
});

describe("entryProblems over a fixture tree", () => {
  const tree = (folders: readonly string[]): string => {
    const root = mkdtempSync(join(tmpdir(), "ductura-entry-"));
    for (const folder of folders) {
      mkdirSync(join(root, "server", folder), { recursive: true });
      writeFileSync(join(root, "server", folder, "routes.ts"), "export const R = [];\n");
    }
    mkdirSync(join(root, "server", "external"), { recursive: true });
    return root;
  };
  const entry = (names: readonly string[]): string =>
    `const AREAS: readonly AreaWithRoutes[] = [${names.map((n) => `"${n}"`).join(", ")}];\n`;

  it.each([
    [
      "an area folder with routes that is not named",
      ["roles", "novo"],
      ["roles"],
      ["roles", "novo"],
      "server/novo has routes, not in AREAS",
    ],
    [
      "a name with no folder",
      ["roles"],
      ["roles", "ghost"],
      ["roles"],
      "ghost in AREAS has no routes.ts",
    ],
    [
      "an external adapter that is not named",
      ["roles", "external/novo"],
      ["roles"],
      ["roles", "external/novo"],
      "server/external/novo has routes, not in AREAS",
    ],
    [
      "a folder missing from the http registry",
      ["roles", "legal"],
      ["roles", "legal"],
      ["roles"],
      "server/legal not in http AREA_NAMES",
    ],
  ])("fails on %s", (_, folders, named, registry, problem) => {
    const root = tree(folders);
    try {
      expect(entryProblems(root, entry(named), registry)).toEqual([problem]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // QA on 8366c2e: a commented-out name is not mounted; a name twice is a slip.
  it.each([
    ["a commented-out name", ['"roles"', '// "legal",'], "server/legal has routes, not in AREAS"],
    [
      "a block-commented name",
      ['"roles"', '/* "legal" */'],
      "server/legal has routes, not in AREAS",
    ],
    ["a name twice", ['"roles"', '"legal"', '"legal"'], "legal named twice in AREAS"],
  ])("fails on %s", (_, items, problem) => {
    const root = tree(["roles", "legal"]);
    try {
      const text = `const AREAS: readonly AreaWithRoutes[] = [\n${items.join("\n")}\n];\n`;
      expect(entryProblems(root, text, ["roles", "legal"])).toEqual([problem]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when all three agree and test-server stays out", () => {
    const root = tree(["roles", "test-server"]);
    try {
      expect(entryProblems(root, entry(["roles"]), ["roles"])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
