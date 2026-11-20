import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PENDING_TESTS } from "./pending-tests.ts";

describe("PENDING_TESTS (ZEL-S4)", () => {
  it("is what tsconfig.json leaves out, besides node_modules", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { exclude: string[] };
    expect(tsconfig.exclude.filter((path) => path !== "node_modules")).toEqual([...PENDING_TESTS]);
  });

  it("names only files that exist", () => {
    for (const path of PENDING_TESTS) {
      expect(() => readFileSync(path)).not.toThrow();
    }
  });
});
