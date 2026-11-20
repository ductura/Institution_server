import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { DUCTUS_LEGACY_DATABASE } from "../vitest.config.ts";
import { PENDING_TESTS } from "./pending-tests.ts";

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

  it("names only files that exist", () => {
    for (const path of PENDING_TESTS) {
      expect(() => readFileSync(path)).not.toThrow();
    }
  });
});
