import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const IDS = [
  "F-001",
  "F-003",
  "F-004",
  "F-005",
  "F-006",
  "F-007",
  "F-008",
  "F-028",
  "F-029",
  "F-030",
  "F-034",
  "F-037",
  "F-038",
  "F-043",
  "F-048",
  "F-049",
  "F-154",
];

const doc = readFileSync(new URL("../../docs/nalazi/M3.7.md", import.meta.url), "utf8");
const rows = doc
  .split("\n")
  .map((line) => /^\| (F-\d{3}) +\| (\S+) +\| (.+?) +\|$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null);

describe("docs/nalazi/M3.7.md", () => {
  it("has exactly one row per finding ID of plan step M3.7", () => {
    expect(rows.map((r) => r[1]).sort()).toEqual([...IDS].sort());
  });

  it("gives every row a known state and a non-empty proof", () => {
    for (const [, id, state, proof] of rows) {
      expect(["zatvoreno", "otvoreno"], id).toContain(state);
      expect(proof?.length, id).toBeGreaterThan(0);
    }
  });

  it("points a closed row to an existing test file", () => {
    for (const [, id, state, proof] of rows) {
      if (state !== "zatvoreno") continue;
      const path = /`([^`]+\.test\.ts)`/.exec(proof ?? "")?.[1];
      expect(path, id).toBeDefined();
      expect(existsSync(new URL(`../../${path}`, import.meta.url)), id).toBe(true);
    }
  });
});
