// SRV-V15-OPISNA (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.4): the pure
// computation of descriptive statistics of one numeric column. Written from the
// textbook definitions (sample variance with n - 1, quartiles by linear
// interpolation between order statistics), no code of any statistics package.
//
// Repeatable byte for byte: the values are sorted before they are summed, so the
// order of the rows cannot change a result; the sums are compensated (Neumaier) in
// that fixed order; there is no clock and no randomness; every number leaves
// through one rounding helper. The input is a plain column, not a dataset type, so
// this file depends on nothing but the language.

/** Decimals kept in every number of a result (contract: "rounded to 6 decimals"). */
export const ANALYSIS_DECIMALS = 6;

/**
 * Rounds to `ANALYSIS_DECIMALS` through the exact decimal expansion of the double
 * (`toFixed`), so the same double always gives the same number. Negative zero
 * becomes 0 and a value that is not finite becomes `null`: neither is JSON.
 */
export function roundResult(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(ANALYSIS_DECIMALS));
  if (!Number.isFinite(rounded)) return null;
  return rounded === 0 ? 0 : rounded;
}

export type DescriptiveColumn = {
  readonly name: string;
  /** Cells that hold a number. */
  readonly n: number;
  /** Cells that do not (`null`, or a value that is not a finite number). */
  readonly missing: number;
  readonly mean: number | null;
  /** Sample standard deviation (n - 1); null for n < 2. */
  readonly sd: number | null;
  readonly median: number | null;
  readonly min: number | null;
  readonly q1: number | null;
  readonly q3: number | null;
  readonly max: number | null;
};

/** Sum of ascending values with Neumaier compensation; the order is part of the result. */
function sumSorted(sorted: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of sorted) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + compensation;
}

/**
 * Quantile `p` (0..1) of an ascending, non-empty list by linear interpolation:
 * position h = (n - 1) * p, value s[floor(h)] + (h - floor(h)) * (s[floor(h) + 1] - s[floor(h)]).
 * With p = 1/2 this is the middle value, or the mean of the two middle values.
 */
export function quantileSorted(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[Math.min(lower + 1, sorted.length - 1)] ?? low;
  const fraction = position - lower;
  // Exact at the ends and for equal neighbours, which keeps a constant column exact.
  return fraction === 0 || low === high ? low : low + fraction * (high - low);
}

/**
 * Descriptive statistics of one column. Total: it never throws. A cell that is not
 * a finite number counts as missing, so the result cannot hold NaN or Infinity.
 * Where a measure is not defined (no values; one value for `sd`) it is `null`.
 */
export function describeNumeric(name: string, cells: readonly unknown[]): DescriptiveColumn {
  const present: number[] = [];
  for (const cell of cells) {
    // `+ 0` turns -0 into 0 so that it cannot reach the output.
    if (typeof cell === "number" && Number.isFinite(cell)) present.push(cell + 0);
  }
  const sorted = present.sort((a, b) => a - b);
  const n = sorted.length;
  const missing = cells.length - n;
  if (n === 0) {
    return {
      name,
      n,
      missing,
      mean: null,
      sd: null,
      median: null,
      min: null,
      q1: null,
      q3: null,
      max: null,
    };
  }
  // Everything is computed on values shifted by the smallest one: a common offset of
  // 1e15 would otherwise swallow the deviations (the shifted values are exact enough).
  const shift = sorted[0] ?? 0;
  const shifted = sorted.map((value) => value - shift);
  const shiftedMean = sumSorted(shifted) / n;
  const mean = shift + shiftedMean;
  let sd: number | null = null;
  if (n >= 2) {
    // Two passes: squared deviations from the shifted mean, in ascending order.
    const squares = shifted.map((value) => (value - shiftedMean) * (value - shiftedMean));
    sd = roundResult(Math.sqrt(sumSorted(squares.sort((a, b) => a - b)) / (n - 1)));
  }
  return {
    name,
    n,
    missing,
    mean: roundResult(mean),
    sd,
    median: roundResult(quantileSorted(sorted, 0.5)),
    min: roundResult(sorted[0] ?? 0),
    q1: roundResult(quantileSorted(sorted, 0.25)),
    q3: roundResult(quantileSorted(sorted, 0.75)),
    max: roundResult(sorted[n - 1] ?? 0),
  };
}
