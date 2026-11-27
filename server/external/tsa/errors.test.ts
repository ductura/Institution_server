import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TSA_ERROR_CODES, tsaError, tsaMessageKey } from "./index.ts";

// docs/CODE_STYLE.md §8: every code has a message key with Croatian text in
// locales/hr.json, and the `tsa` section holds nothing else.
const HR = JSON.parse(
  readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const section = HR["tsa"] as Record<string, unknown>;

describe("TSA error codes", () => {
  it("are unique UPPER_SNAKE codes with the TSA_ prefix", () => {
    expect(new Set(TSA_ERROR_CODES).size).toBe(TSA_ERROR_CODES.length);
    for (const code of TSA_ERROR_CODES) expect(code).toMatch(/^TSA_[A-Z]+(?:_[A-Z]+)*$/u);
  });

  it("each has Croatian text, and the section has no other keys", () => {
    const keys = TSA_ERROR_CODES.map((code) => tsaMessageKey(code).slice("tsa.".length));
    expect(Object.keys(section).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const text = section[key];
      expect(typeof text === "string" && text.trim().length > 0, key).toBe(true);
    }
  });

  it("tsaError pairs a code with its key", () => {
    expect(tsaError("TSA_CHAIN")).toEqual({ code: "TSA_CHAIN", messageKey: "tsa.chain" });
  });
});
