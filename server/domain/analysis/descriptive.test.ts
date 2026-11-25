import { describe, expect, it } from "vitest";

import { ANALYSIS_DECIMALS, describeNumeric, quantileSorted, roundResult } from "./descriptive.ts";

// Invented numbers, worked out by hand (see the comments).
const WORKED = [2, 4, 4, 4, 5, 5, 7, 9];

describe("describeNumeric", () => {
  it("matches a hand-worked example (n = 8)", () => {
    // sum 40, mean 5; squared deviations 9+1+1+1+0+0+4+16 = 32; sample variance 32/7, sd 2.13809
    // sorted positions: q1 at 1.75 -> 4, median at 3.5 -> 4.5, q3 at 5.25 -> 5 + 0.25 * 2 = 5.5
    expect(describeNumeric("x", WORKED)).toEqual({
      name: "x",
      n: 8,
      missing: 0,
      mean: 5,
      sd: 2.13809,
      median: 4.5,
      min: 2,
      q1: 4,
      q3: 5.5,
      max: 9,
    });
  });

  it("interpolates the quartiles linearly (n = 4)", () => {
    // positions 0.75, 1.5, 2.25 of [1, 2, 3, 4]: 1.75, 2.5, 3.25; sd = sqrt(5 / 3)
    const result = describeNumeric("x", [4, 1, 3, 2]);
    expect([result.q1, result.median, result.q3, result.mean, result.sd]).toEqual([
      1.75, 2.5, 3.25, 2.5, 1.290994,
    ]);
  });

  it("uses the sample (n - 1) deviation, not the population one", () => {
    // population sd of [1, 3] would be 1; the sample one is sqrt(2)
    expect(describeNumeric("x", [1, 3]).sd).toBe(1.414214);
  });

  it("counts null and non-finite cells as missing and leaves them out", () => {
    const result = describeNumeric("x", [1, null, 3, Number.NaN, Infinity, "7", undefined]);
    expect(result.n).toBe(2);
    expect(result.missing).toBe(5);
    expect(result.mean).toBe(2);
  });

  it("gives the same result for every order of the rows", () => {
    const base = describeNumeric("x", WORKED);
    const messy = [0.1, 0.2, 0.3, 1e10, -1e10, 0.7, 12.345678, 3];
    const first = describeNumeric("y", messy);
    const orders = [
      [...messy].reverse(),
      [...messy].sort((a, b) => b - a),
      messy.slice(3).concat(messy.slice(0, 3)),
    ];
    for (const order of orders) expect(describeNumeric("y", order)).toEqual(first);
    expect(describeNumeric("x", [...WORKED].reverse())).toEqual(base);
  });

  it("is exact where plain summation is not", () => {
    // 0.1 added ten times is 0.9999999999999999 without compensation, and 1 / 10 rounds to 0.1 either way;
    // the compensated sum keeps a long column of 0.1 at exactly 0.1 with sd 0
    const result = describeNumeric(
      "x",
      Array.from({ length: 500 }, () => 0.1),
    );
    expect(result.mean).toBe(0.1);
    expect(result.sd).toBe(0);
  });

  it("gives null where nothing is defined (n = 0)", () => {
    for (const cells of [[], [null, null], [Number.NaN]]) {
      expect(describeNumeric("x", cells)).toEqual({
        name: "x",
        n: 0,
        missing: cells.length,
        mean: null,
        sd: null,
        median: null,
        min: null,
        q1: null,
        q3: null,
        max: null,
      });
    }
  });

  it("gives one value for every measure but sd (n = 1)", () => {
    expect(describeNumeric("x", [null, 4.5])).toEqual({
      name: "x",
      n: 1,
      missing: 1,
      mean: 4.5,
      sd: null,
      median: 4.5,
      min: 4.5,
      q1: 4.5,
      q3: 4.5,
      max: 4.5,
    });
  });

  it("never returns negative zero", () => {
    const result = describeNumeric("x", [-0, 0, -0.0000001]);
    for (const key of ["mean", "median", "min", "q1", "q3", "max", "sd"] as const) {
      expect(Object.is(result[key], -0), key).toBe(false);
    }
    expect(describeNumeric("x", [-0]).mean).toBe(0);
    expect(Object.is(describeNumeric("x", [-0]).max, 0)).toBe(true);
  });

  it("keeps big and tiny values finite and serialisable", () => {
    const big = describeNumeric("x", [1e15, -1e15, 1e15]);
    expect(Number.isFinite(big.sd)).toBe(true);
    expect(JSON.parse(JSON.stringify(big))).toEqual(big);
    expect(describeNumeric("x", [1e-9, 2e-9]).mean).toBe(0);
  });

  it("does not change its input", () => {
    const cells = Object.freeze([3, 1, 2]);
    expect(() => describeNumeric("x", cells)).not.toThrow();
    expect(cells).toEqual([3, 1, 2]);
  });
});

describe("roundResult", () => {
  it("rounds to six decimals through one helper", () => {
    expect(ANALYSIS_DECIMALS).toBe(6);
    expect(roundResult(1 / 3)).toBe(0.333333);
    expect(roundResult(2 / 3)).toBe(0.666667);
    expect(roundResult(-0.0000004)).toBe(0);
    expect(roundResult(Number.NaN)).toBeNull();
    expect(roundResult(Infinity)).toBeNull();
  });
});

describe("quantileSorted", () => {
  it("returns the ends and a single value exactly", () => {
    expect(quantileSorted([7], 0.25)).toBe(7);
    expect(quantileSorted([1, 5, 9], 0)).toBe(1);
    expect(quantileSorted([1, 5, 9], 1)).toBe(9);
    expect(quantileSorted([1, 5, 9], 0.5)).toBe(5);
  });
});
