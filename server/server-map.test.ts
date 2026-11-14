import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFolders,
  listAreaFolders,
  readAreas,
  readCallers,
  readImports,
  readTable,
} from "./server-map.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MAP = readFileSync(join(ROOT, "docs", "server-map.md"), "utf8");

// The areas S-0.12 asks for. The map may not drop or add one silently.
const REQUIRED_AREAS = [
  "http",
  "traffic",
  "session",
  "external/srce-auth",
  "external/storage",
  "external/keys",
  "external/email",
  "database",
  "log",
  "metrics",
  "roles",
  "settings",
  "config",
  "legal",
  "backup",
  "deletion",
  "downloads",
  "contracts",
  "domain",
  "test-server",
];

describe("readTable and readAreas", () => {
  const sample = [
    "## 1. Područja",
    "",
    "| Područje | Mapa | Stanje |",
    "|---|---|---|",
    "| http | `server/http` | planirano |",
    "| log | `server/logs` | postoji |",
    "| roles | `server/roles` | gotovo |",
    "| http | `server/http` | postoji |",
    "",
    "## 2. Dopušteni uvozi",
    "",
    "| Područje | Smije uvoziti |",
    "|---|---|",
    "| domain | — |",
    "| log | `settings`, `metrics` |",
    "| log | `settings` |",
    "| metrics | settings |",
  ].join("\n");

  it("reads only the first table after the heading, without header", () => {
    expect(readTable(sample, "## 2. Dopušteni uvozi")).toEqual([
      ["domain", "—"],
      ["log", "`settings`, `metrics`"],
      ["log", "`settings`"],
      ["metrics", "settings"],
    ]);
    expect(readTable(sample, "## 9. Nema")).toEqual([]);
  });

  it("reports a wrong folder, an unknown status and a duplicate", () => {
    const { areas, problems } = readAreas(sample);
    expect(areas.map((a) => a.key)).toEqual(["http", "http"]);
    expect(problems).toEqual([
      "log: folder must be `server/log`",
      'roles: unknown status "gotovo"',
      "http: listed twice",
    ]);
  });

  it("reads import targets, reports a duplicate and a cell without backticks", () => {
    const { imports, problems } = readImports(sample);
    expect([...imports]).toEqual([
      ["domain", []],
      ["log", ["settings", "metrics"]],
    ]);
    expect(problems).toEqual(["log: listed twice", "metrics: write targets in backticks or —"]);
  });
});

describe("readCallers", () => {
  it("reads backticked names from the callers column", () => {
    const md = [
      "## 1. Područja",
      "| Područje | Mapa | Svrha | Tko ga zove | Podaci | Stanje |",
      "|---|---|---|---|---|---|",
      "| log | `server/log` | Zapisi | `http`, `sesion` | Baza zapisa | planirano |",
      "| roles | `server/roles` | Uloge | samo testovi | — | planirano |",
    ].join("\n");
    expect([...readCallers(md)]).toEqual([
      ["log", ["http", "sesion"]],
      ["roles", []],
    ]);
  });
});

describe("checkFolders", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds missing, unmarked and unmapped folders", () => {
    dir = mkdtempSync(join(tmpdir(), "server-map-"));
    for (const path of [
      "server/contracts",
      "server/http",
      "server/stray",
      "server/external/email",
    ]) {
      mkdirSync(join(dir, path), { recursive: true });
    }
    const folders = listAreaFolders(dir);
    expect(folders).toEqual(["contracts", "external/email", "http", "stray"]);
    const areas = [
      { key: "contracts", dir: "server/contracts", status: "postoji" },
      { key: "http", dir: "server/http", status: "planirano" },
      { key: "log", dir: "server/log", status: "postoji" },
      { key: "external/email", dir: "server/external/email", status: "postoji" },
    ] as const;
    expect(checkFolders([...areas], folders)).toEqual([
      "server/http exists: mark it postoji",
      "server/log is marked postoji but is missing",
      "server/stray is not in docs/server-map.md",
    ]);
  });
});

describe("docs/server-map.md", () => {
  const { areas, problems } = readAreas(MAP);
  const keys = areas.map((a) => a.key);
  const { imports, problems: importProblems } = readImports(MAP);
  const importers = (target: string): string[] =>
    [...imports].filter(([, targets]) => targets.includes(target)).map(([area]) => area);

  it("lists exactly the required areas, each row well formed", () => {
    expect(problems).toEqual([]);
    expect([...keys].sort()).toEqual([...REQUIRED_AREAS].sort());
  });

  // Planned folders are only a list until S-1A-a creates them: this checks the
  // folders marked postoji, and that no folder exists unmapped or still planned.
  it("matches the folders under server/", () => {
    expect(areas.filter((a) => a.status === "postoji").length).toBeGreaterThan(0);
    expect(checkFolders(areas, listAreaFolders(ROOT))).toEqual([]);
  });

  it("has an import row for every area, naming only known areas", () => {
    expect(importProblems).toEqual([]);
    expect([...imports.keys()].sort()).toEqual([...keys].sort());
    for (const [area, targets] of imports) {
      for (const target of targets) {
        expect(keys, `${area} imports ${target}`).toContain(target);
        expect(target, `${area} imports itself`).not.toBe(area);
      }
    }
  });

  it("keeps the inward direction of imports", () => {
    expect(imports.get("domain")).toEqual([]);
    expect(imports.get("contracts")).toEqual([]);
    expect(importers("http")).toEqual(["test-server"]);
    expect(importers("test-server")).toEqual([]);
    for (const area of keys.filter((k) => k.startsWith("external/"))) {
      expect(imports.get(area)?.filter((t) => !["settings", "log", "metrics"].includes(t))).toEqual(
        [],
      );
    }
  });

  it("names as callers exactly the areas that may import each area", () => {
    for (const [area, callers] of readCallers(MAP)) {
      expect(
        callers.filter((c) => c !== "server.ts" && !keys.includes(c)),
        `${area}`,
      ).toEqual([]);
      const named = callers.filter((c) => keys.includes(c)).sort();
      expect(named, `callers of ${area}`).toEqual(importers(area).sort());
    }
  });
});
