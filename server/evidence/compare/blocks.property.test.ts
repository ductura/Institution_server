// SRV-9E: every difference holds both versions whole, in order, whatever the
// cell limit; within the limit it keeps as many blocks unchanged as possible.
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { type CompareBlock, type CompareEntry, diffBlocks } from "./blocks.ts";

const block = fc
  .constantFrom("A", "B", "C", "D")
  .map((text): CompareBlock => ({ kind: "paragraph", text }));
const strip = ({ change: _, ...rest }: CompareEntry): CompareBlock => rest;

/** Length of the longest common subsequence, by a plain table. */
function lcs(a: readonly CompareBlock[], b: readonly CompareBlock[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = x.text === b[j - 1]!.text ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = up;
    }
  }
  return row[b.length]!;
}

test.prop([fc.array(block, { maxLength: 12 }), fc.array(block, { maxLength: 12 }), fc.nat(200)])(
  "the difference holds both versions in order",
  (before, after, maxCells) => {
    const result = diffBlocks(before, after, maxCells);
    expect(result.filter((e) => e.change !== "added").map(strip)).toStrictEqual(before);
    expect(result.filter((e) => e.change !== "removed").map(strip)).toStrictEqual(after);
  },
);

test.prop([fc.array(block, { maxLength: 12 }), fc.array(block, { maxLength: 12 })])(
  "within the cell limit the unchanged blocks are a longest common subsequence",
  (before, after) => {
    const unchanged = diffBlocks(before, after).filter((e) => e.change === "unchanged");
    expect(unchanged).toHaveLength(lcs(before, after));
  },
);
