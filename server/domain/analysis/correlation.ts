// Pearson correlation for the statistics tool (SRV-V15-KORELACIJA, val 15).
// Pure and deterministic: no clock, no randomness, no I/O, no identity. The same
// columns in the same order give the same bytes, and the order of the rows does
// not matter (the sums run over pairs sorted by value). Never throws on bad
// input: a value that is not a finite number counts as missing. No p-value.

export type CorrelationColumn = { name: string; values: readonly (number | null)[] };

/** `r` is null when n < 3, when either column is constant, or when it is not finite. */
export type CorrelationPair = { a: string; b: string; n: number; r: number | null };

/** Fewest complete pairs for which `r` is defined. */
export const CORRELATION_MIN_PAIRS = 3;
const DECIMALS = 1e6;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round6(value: number): number {
  const rounded = Math.round(value * DECIMALS) / DECIMALS;
  return rounded === 0 ? 0 : rounded; // no -0 in the output
}

/** Pearson r over complete pairs; `xs` and `ys` are the same length. */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < CORRELATION_MIN_PAIRS) return null;
  const order = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]! || ys[i]! - ys[j]!);
  const x = order.map((i) => xs[i]!);
  const y = order.map((i) => ys[i]!);
  // An exactly constant column has no variance; checked on the values, not on
  // the deviations, so rounding of the mean cannot fake a variance.
  if (x[0] === x[n - 1] || Math.min(...y) === Math.max(...y)) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += x[i]!;
    sumY += y[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const denominator = Math.sqrt(sxx * syy);
  if (!(denominator > 0) || !Number.isFinite(denominator)) return null;
  const r = sxy / denominator;
  if (!Number.isFinite(r)) return null;
  return round6(Math.max(-1, Math.min(1, r)));
}

/** Pearson r of two columns, pairwise deletion; `n` is the number of complete pairs. */
export function correlatePair(a: CorrelationColumn, b: CorrelationColumn): CorrelationPair {
  // Computed in name order so that r(a, b) and r(b, a) are the same bytes.
  const [first, second] = a.name <= b.name ? [a, b] : [b, a];
  const xs: number[] = [];
  const ys: number[] = [];
  const length = Math.min(first.values.length, second.values.length);
  for (let i = 0; i < length; i += 1) {
    const x = first.values[i];
    const y = second.values[i];
    if (isNumber(x) && isNumber(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  return { a: a.name, b: b.name, n: xs.length, r: pearson(xs, ys) };
}

/** Every pair i < j of the columns in the given order (k columns give k(k-1)/2 pairs). */
export function correlate(columns: readonly CorrelationColumn[]): CorrelationPair[] {
  const pairs: CorrelationPair[] = [];
  for (let i = 0; i < columns.length; i += 1) {
    for (let j = i + 1; j < columns.length; j += 1) {
      pairs.push(correlatePair(columns[i]!, columns[j]!));
    }
  }
  return pairs;
}
