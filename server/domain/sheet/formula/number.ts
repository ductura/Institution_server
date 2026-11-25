/**
 * Number rules of the formula computer (decision 3 of the val 14 review).
 * Numbers are IEEE 754 binary64. Rounding works on the shortest decimal text
 * that reads back as the same double (what `toExponential()` yields), half
 * away from zero, so it never depends on the locale, the platform or the
 * order of operations: ROUND(2.675, 2) is 2.68 and 0.1 + 0.2 shows as 0.3.
 */

/** Significant digits shown in a result, in the CSV and in the .xlsx. */
export const RESULT_SIGNIFICANT_DIGITS = 15;

const PLAIN_DECIMAL = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;

/** `-0` never appears in a result. */
export function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Plain decimal text ("12", "-1.5", ".5") as a finite number; `null` for anything else. */
export function parseDecimalText(text: string): number | null {
  if (!PLAIN_DECIMAL.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? normalizeZero(value) : null;
}

// |value| = d.ddd × 10^exponent with the fewest digits that read back exactly.
function decimalParts(value: number): { digits: string; exponent: number } {
  const [mantissa = "0", exponent = "0"] = Math.abs(value).toExponential().split("e");
  return { digits: mantissa.replace(".", ""), exponent: Number(exponent) };
}

// Keeps the first `keep` significant digits, half away from zero.
function roundKeep(value: number, digits: string, exponent: number, keep: number): number {
  if (value === 0 || keep >= digits.length) return value;
  if (keep < 0) return 0;
  let kept = keep === 0 ? 0n : BigInt(digits.slice(0, keep));
  if (digits.charCodeAt(keep) >= "5".charCodeAt(0)) kept += 1n;
  if (kept === 0n) return 0;
  const rounded = Number(`${kept}e${exponent - keep + 1}`);
  return value < 0 ? -rounded : rounded;
}

/** `ROUND(value, decimals)`: `decimals` is a whole number, negative rounds left of the point. */
export function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const { digits, exponent } = decimalParts(value);
  return normalizeZero(roundKeep(value, digits, exponent, exponent + 1 + decimals));
}

/** The value a result shows: at most 15 significant digits. */
export function roundResult(value: number): number {
  if (!Number.isFinite(value)) return value;
  const { digits, exponent } = decimalParts(value);
  const rounded = roundKeep(value, digits, exponent, RESULT_SIGNIFICANT_DIGITS);
  if (Number.isFinite(rounded)) return normalizeZero(rounded);
  // Rounding up at the very top of the range must not overflow: cut the digits instead.
  const cut = Number(
    `${digits.slice(0, RESULT_SIGNIFICANT_DIGITS)}e${exponent - RESULT_SIGNIFICANT_DIGITS + 1}`,
  );
  return value < 0 ? -cut : cut;
}

/** Code point order, the same on every platform (not UTF-16 unit order, not locale order). */
export function compareText(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
