import { describe, expect, it } from "vitest";

import { correlate, correlatePair } from "./correlation.ts";

const col = (name: string, values: (number | null)[]) => ({ name, values });
const X = col("x", [1, 2, 3, 4, 5]);

describe("correlatePair", () => {
  it("perfect positive and negative correlation", () => {
    expect(correlatePair(X, col("y", [2, 4, 6, 8, 10]))).toEqual({ a: "x", b: "y", n: 5, r: 1 });
    expect(correlatePair(X, col("y", [10, 8, 6, 4, 2])).r).toBe(-1);
  });

  it("hand-computed value", () => {
    // x = 1..5, y = 2,1,4,3,5: sxy = 8, sxx = 10, syy = 10, r = 0.8
    expect(correlatePair(X, col("y", [2, 1, 4, 3, 5])).r).toBe(0.8);
  });

  it("zero variance gives null, also for non-representable constants", () => {
    expect(correlatePair(X, col("c", [7, 7, 7, 7, 7])).r).toBeNull();
    expect(correlatePair(col("c", [0.1, 0.1, 0.1]), col("y", [1, 2, 3])).r).toBeNull();
  });

  it("n < 3 gives null and reports n", () => {
    expect(correlatePair(col("a", [1, 2]), col("b", [3, 4]))).toEqual({
      a: "a",
      b: "b",
      n: 2,
      r: null,
    });
    expect(correlatePair(col("a", []), col("b", []))).toEqual({ a: "a", b: "b", n: 0, r: null });
  });

  it("pairwise deletion of missing and non-finite values", () => {
    const y = col("y", [2, null, 6, 8, Number.NaN, 12]);
    const x = col("x", [1, 2, 3, 4, 5, Number.POSITIVE_INFINITY]);
    expect(correlatePair(x, y)).toEqual({ a: "x", b: "y", n: 3, r: 1 });
  });

  it("different lengths use the common prefix, never throw", () => {
    expect(correlatePair(X, col("y", [2, 4, 6])).n).toBe(3);
  });

  it("r(a, b) equals r(b, a) byte for byte", () => {
    const y = col("y", [3.3, 1.1, 4.4, 1.7, 5.9, 2.6]);
    const x = col("x", [0.3, 0.1, 0.7, 0.2, 0.9, 0.31]);
    const ab = correlatePair(x, y);
    const ba = correlatePair(y, x);
    expect(ab.r).toBe(ba.r);
    expect(ab.n).toBe(ba.n);
    expect(ba.a).toBe("y");
  });

  it("row permutation does not change the result", () => {
    const xs = [0.1, 0.7, 0.2, 0.9, 0.31, 0.45, 0.8];
    const ys = [3.3, 1.1, 4.4, 1.7, 5.9, 2.6, 0.2];
    const base = correlatePair(col("x", xs), col("y", ys));
    for (const order of [
      [6, 5, 4, 3, 2, 1, 0],
      [3, 0, 6, 1, 5, 2, 4],
    ]) {
      const p = correlatePair(
        col(
          "x",
          order.map((i) => xs[i]!),
        ),
        col(
          "y",
          order.map((i) => ys[i]!),
        ),
      );
      expect(p).toEqual(base);
    }
  });

  it("r stays inside [-1, 1] and has no -0", () => {
    const big = col("big", [1e15, 2e15, 3e15, 4e15]);
    const r = correlatePair(big, col("y", [1, 2, 3, 4])).r;
    expect(r).toBe(1);
    const zero = correlatePair(col("a", [1, 2, 3, 4, 5]), col("b", [1, 3, 5, 3, 1])).r;
    expect(Object.is(zero, 0)).toBe(true);
  });

  it("overflow gives null, not NaN", () => {
    const huge = col("h", [1e308, -1e308, 5e307]);
    expect(correlatePair(huge, col("y", [1, 2, 4])).r).toBeNull();
  });

  it("rounds to 6 decimals", () => {
    const r = correlatePair(col("x", [1, 2, 3, 4]), col("y", [1, 3, 2, 5])).r!;
    expect(r).toBe(Math.round(r * 1e6) / 1e6);
    expect(r).toBe(0.831522); // 5.5 / sqrt(5 * 8.75)
  });
});

describe("correlate", () => {
  it("returns k(k-1)/2 pairs in column order", () => {
    const pairs = correlate([X, col("y", [2, 4, 6, 8, 10]), col("z", [5, 4, 3, 2, 1])]);
    expect(pairs.map((p) => [p.a, p.b, p.r])).toEqual([
      ["x", "y", 1],
      ["x", "z", -1],
      ["y", "z", -1],
    ]);
  });

  it("fewer than two columns give no pairs", () => {
    expect(correlate([])).toEqual([]);
    expect(correlate([X])).toEqual([]);
  });

  it("same input twice gives equal bytes", () => {
    const cols = [X, col("y", [2, 1, 4, 3, 5]), col("z", [1, null, 2, 9, 4])];
    expect(JSON.stringify(correlate(cols))).toBe(JSON.stringify(correlate(cols)));
  });
});
