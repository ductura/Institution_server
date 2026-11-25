import { describe, expect, it } from "vitest";

import { compareCroatian, FREQUENCY_MAX_VALUES, tabulate } from "./frequencies.ts";

describe("tabulate", () => {
  it("counts, orders by count and gives the share of the present cells", () => {
    const result = tabulate("c", ["b", "a", "b", null, "c", "b", "a", ""]);
    expect(result).toEqual({
      name: "c",
      n: 6,
      missing: 2,
      values: [
        { value: "b", count: 3, share: 0.5 },
        { value: "a", count: 2, share: 0.333333 },
        { value: "c", count: 1, share: 0.166667 },
      ],
      otherCount: 0,
    });
  });

  it("breaks a tie by the Croatian alphabet (č, ć, š, ž, đ)", () => {
    const cells = ["ž", "z", "š", "s", "đ", "d", "ć", "č", "c", "dž", "e"];
    expect(tabulate("c", cells).values.map((entry) => entry.value)).toEqual([
      "c",
      "č",
      "ć",
      "d",
      "dž",
      "đ",
      "e",
      "s",
      "š",
      "z",
      "ž",
    ]);
  });

  it("does not depend on the order of the rows", () => {
    const cells = ["šuma", "more", "Šuma", "more", "čaj", null, "caj", "ćup", "čaj", "žito"];
    const first = tabulate("c", cells);
    expect(tabulate("c", [...cells].reverse())).toEqual(first);
    expect(tabulate("c", [...cells].sort())).toEqual(first);
  });

  it("lists at most 50 values and counts the rest in otherCount", () => {
    expect(FREQUENCY_MAX_VALUES).toBe(50);
    // 60 distinct texts: v00 appears three times, v01 twice, the rest once
    const cells: string[] = [];
    for (let i = 0; i < 60; i++) cells.push(`v${String(i).padStart(2, "0")}`);
    cells.push("v00", "v00", "v01");
    const result = tabulate("c", cells);
    expect(result.n).toBe(63);
    expect(result.values).toHaveLength(50);
    expect(result.values[0]).toEqual({ value: "v00", count: 3, share: 0.047619 });
    expect(result.values[1]?.value).toBe("v01");
    expect(result.values[2]?.value).toBe("v02");
    expect(result.values[49]?.value).toBe("v49");
    expect(result.otherCount).toBe(10);
    expect(result.values.reduce((sum, entry) => sum + entry.count, 0) + result.otherCount).toBe(
      result.n,
    );
  });

  it("gives an empty table for no values", () => {
    expect(tabulate("c", [])).toEqual({ name: "c", n: 0, missing: 0, values: [], otherCount: 0 });
    expect(tabulate("c", [null, "", Number.NaN])).toEqual({
      name: "c",
      n: 0,
      missing: 3,
      values: [],
      otherCount: 0,
    });
  });

  it("counts a single value as the whole column", () => {
    expect(tabulate("c", ["x"]).values).toEqual([{ value: "x", count: 1, share: 1 }]);
  });

  it("tabulates numbers as text and merges -0 with 0", () => {
    const result = tabulate("c", [1, 1.5, 1, -0, 0, Infinity]);
    expect(result.values).toEqual([
      { value: "0", count: 2, share: 0.4 },
      { value: "1", count: 2, share: 0.4 },
      { value: "1.5", count: 1, share: 0.2 },
    ]);
    expect(result.missing).toBe(1);
  });

  it("treats prototype names as ordinary values", () => {
    const result = tabulate("c", ["__proto__", "constructor", "__proto__", "toString"]);
    expect(result.values.map((entry) => [entry.value, entry.count])).toEqual([
      ["__proto__", 2],
      ["constructor", 1],
      ["toString", 1],
    ]);
  });

  it("serialises to JSON without loss", () => {
    const result = tabulate("c", ["a", "b", "a"]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("compareCroatian", () => {
  it("is a total order that never ties two different texts", () => {
    expect(compareCroatian("a", "a")).toBe(0);
    expect(compareCroatian("a", "A")).not.toBe(0);
    expect(compareCroatian("a", "A")).toBe(-compareCroatian("A", "a"));
    expect(compareCroatian("ab", "a")).toBeGreaterThan(0);
  });

  it("puts lj, nj and dž after the letter they start with", () => {
    expect(compareCroatian("lijep", "ljeto")).toBeLessThan(0);
    expect(compareCroatian("ljeto", "m")).toBeLessThan(0);
    expect(compareCroatian("lz", "lj")).toBeLessThan(0);
    expect(compareCroatian("dz", "dž")).toBeLessThan(0);
    expect(compareCroatian("dž", "đ")).toBeLessThan(0);
  });

  it("puts digits and other signs before letters", () => {
    expect(compareCroatian("2", "a")).toBeLessThan(0);
    expect(compareCroatian("-", "1")).toBeLessThan(0);
  });
});
