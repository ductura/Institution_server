import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { DUCTUS_LEGACY_DATABASE, PENDING_TESTS } from "./index.ts";

describe("PENDING_TESTS (ZEL-S4)", () => {
  it("excludes pending files from both TypeScript projects", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { exclude: string[] };
    const copiedTestsFile = "tsconfig.ductus-tests.json";
    const parsed = ts.parseConfigFileTextToJson(
      copiedTestsFile,
      readFileSync(copiedTestsFile, "utf8"),
    );
    expect(parsed.error).toBeUndefined();
    const copiedTests = parsed.config as {
      include: string[];
      exclude: string[];
    };
    expect(tsconfig.exclude).toEqual([
      ...new Set(["node_modules", ...PENDING_TESTS, ...copiedTests.include]),
    ]);
    expect(copiedTests.exclude).toEqual([
      "node_modules",
      ...PENDING_TESTS,
      ...DUCTUS_LEGACY_DATABASE,
    ]);
  });

  it("are imported by no file outside the list, so production never loads one", () => {
    const pending = new Set(PENDING_TESTS);
    const tracked = execFileSync("git", ["ls-files", "-z", "*.ts", "*.mts", "*.mjs"], {
      encoding: "utf8",
    })
      .split("\0")
      // The isolated Ductus suites run nowhere either (vitest and tsc leave them out).
      .filter(
        (file) => file !== "" && !pending.has(file) && !DUCTUS_LEGACY_DATABASE.includes(file),
      );
    const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/gu;
    const found: string[] = [];
    for (const file of tracked) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec ?? ""));
        if (pending.has(target)) found.push(`${file} -> ${target}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("are left out of lint, as out of tsc and vitest", async () => {
    const eslint = new ESLint({
      overrideConfigFile: "eslint.config.ts",
      flags: ["unstable_native_nodejs_ts_config"],
    });
    for (const path of PENDING_TESTS) expect(await eslint.isPathIgnored(path), path).toBe(true);
    expect(await eslint.isPathIgnored("server/server.ts")).toBe(false);
  });

  it("names only files that exist", () => {
    for (const path of PENDING_TESTS) {
      expect(() => readFileSync(path)).not.toThrow();
    }
  });
});
