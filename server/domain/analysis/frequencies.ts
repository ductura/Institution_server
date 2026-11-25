// SRV-V15-OPISNA (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.4): the pure
// computation of a frequency table of one column. Total (never throws), no clock and
// no randomness. The order of the table does not depend on the order of the rows or
// on the ICU data of the machine: it is ordered by count (descending), then by the
// text in the Croatian alphabet through a comparator written here.

import { roundResult } from "./descriptive.ts";

/** Most values listed per column; the rest is only counted in `otherCount`. */
export const FREQUENCY_MAX_VALUES = 50;

export type FrequencyValue = {
  readonly value: string;
  readonly count: number;
  /** count / n, rounded to 6 decimals. */
  readonly share: number;
};

export type FrequencyColumn = {
  readonly name: string;
  /** Cells that hold a value. */
  readonly n: number;
  /** Cells that do not: `null`, empty text or a number that is not finite. */
  readonly missing: number;
  readonly values: readonly FrequencyValue[];
  /** Cells whose value did not make the first `FREQUENCY_MAX_VALUES` of the table. */
  readonly otherCount: number;
};

/**
 * The Croatian alphabet as code points (server code holds no non-ASCII text literal,
 * local/no-hardcoded-text): a b c č ć d dž đ e f g h i j k l lj m n nj o p r s š t u v z ž.
 * `dž`, `lj` and `nj` are letters of their own (digraphs, two code points each).
 */
const ALPHABET: readonly (readonly number[])[] = [
  [0x61],
  [0x62],
  [0x63],
  [0x10d],
  [0x107],
  [0x64],
  [0x64, 0x17e],
  [0x111],
  [0x65],
  [0x66],
  [0x67],
  [0x68],
  [0x69],
  [0x6a],
  [0x6b],
  [0x6c],
  [0x6c, 0x6a],
  [0x6d],
  [0x6e],
  [0x6e, 0x6a],
  [0x6f],
  [0x70],
  [0x72],
  [0x73],
  [0x161],
  [0x74],
  [0x75],
  [0x76],
  [0x7a],
  [0x17e],
];
const LETTER_RANK = new Map(ALPHABET.map((letter, index) => [letter.join(","), index]));

/** Letters of a text as ranks: [1, index] for an alphabet letter, [0, code point] for the rest. */
function collationKey(text: string): number[] {
  const points = Array.from(
    text.normalize("NFC").toLowerCase(),
    (char) => char.codePointAt(0) ?? 0,
  );
  const key: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i] ?? 0;
    const next = points[i + 1];
    const digraph = next === undefined ? undefined : LETTER_RANK.get(`${point},${next}`);
    if (digraph !== undefined) {
      key.push(1, digraph);
      i++;
      continue;
    }
    const rank = LETTER_RANK.get(String(point));
    if (rank === undefined) key.push(0, point);
    else key.push(1, rank);
  }
  return key;
}

/**
 * Compares two texts in the Croatian alphabet, case-insensitively first (so `č` sorts
 * after `c` and before `ć`, `ž` last); a shorter text that is a prefix comes first.
 * Texts equal in that sense are told apart by code points, so the order is total and
 * two different texts never tie.
 */
export function compareCroatian(a: string, b: string): number {
  const ka = collationKey(a);
  const kb = collationKey(b);
  const length = Math.min(ka.length, kb.length);
  for (let i = 0; i < length; i++) {
    const diff = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (ka.length !== kb.length) return ka.length - kb.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The text a cell is counted under, or null when the cell is missing. */
function valueOf(cell: unknown): string | null {
  if (typeof cell === "string") return cell === "" ? null : cell;
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell + 0);
  return null;
}

/**
 * Frequency table of one column: values by count descending, ties by text in the
 * Croatian alphabet, at most `FREQUENCY_MAX_VALUES` values and the rest in
 * `otherCount`. Share is count / n. A column without values gives an empty table.
 */
export function tabulate(name: string, cells: readonly unknown[]): FrequencyColumn {
  const counts = new Map<string, number>();
  let n = 0;
  for (const cell of cells) {
    const value = valueOf(cell);
    if (value === null) continue;
    n++;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const ordered = [...counts].sort(
    ([textA, countA], [textB, countB]) => countB - countA || compareCroatian(textA, textB),
  );
  const listed = ordered.slice(0, FREQUENCY_MAX_VALUES);
  const listedCount = listed.reduce((sum, [, count]) => sum + count, 0);
  return {
    name,
    n,
    missing: cells.length - n,
    values: listed.map(([value, count]) => ({ value, count, share: roundResult(count / n) ?? 0 })),
    otherCount: n - listedCount,
  };
}
