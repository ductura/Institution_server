import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { computeSheet } from "./index.ts";
import type { Sheet, SheetCell } from "../index.ts";

const SHEET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sheetOf(cells: Record<string, SheetCell>): Sheet {
  return { id: SHEET_ID, name: "List1", rows: 200, columns: 26, cells };
}

function formulaCell(formula: string): SheetCell {
  return { value: null, formula };
}

const number = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });
const FORMULAS = [
  "=B1+1",
  "=A1*B1",
  "=SUM(A1:C2)",
  "=IF(A1>B1,A1,B1)",
  "=C1",
  "=ROUND(A2/3,2)",
  "=COUNT(A1:C3)",
  "=B2-A2",
  "=A3+1",
];

// Same input, same output; the order the cells were written in is not part of the input.
test.prop([
  fc.array(
    fc.tuple(
      fc.constantFrom("A", "B", "C"),
      fc.integer({ min: 1, max: 3 }),
      fc.oneof(number, fc.constantFrom(...FORMULAS)),
    ),
    { maxLength: 9 },
  ),
  fc.integer(),
])("the same cells give the same results in any order of writing", (entries, seed) => {
  const cells = new Map<string, SheetCell>();
  for (const [column, row, content] of entries) {
    cells.set(
      `${column}${row}`,
      typeof content === "number" ? { value: content } : { value: null, formula: content },
    );
  }
  const forward = [...cells.entries()];
  const shuffled = [...forward].sort(
    (a, b) => ((a[0].charCodeAt(1) * 31 + seed) % 7) - ((b[0].charCodeAt(1) * 31 + seed) % 7),
  );
  const one = computeSheet(sheetOf(Object.fromEntries(forward)));
  const two = computeSheet(sheetOf(Object.fromEntries(shuffled.reverse())));
  expect(two).toEqual(one);
  expect(computeSheet(sheetOf(Object.fromEntries(forward)))).toEqual(one);
});

// Moving rows around never changes a sum.
test.prop([fc.array(number, { minLength: 1, maxLength: 40 }), fc.integer()])(
  "SUM and AVERAGE do not depend on the order of the rows",
  (values, seed) => {
    const ordered = values.map((value, index): [string, SheetCell] => [`A${index + 1}`, { value }]);
    const rotated = values.map((_, index): [string, SheetCell] => [
      `A${index + 1}`,
      { value: values[(index + (Math.abs(seed) % values.length)) % values.length]! },
    ]);
    const withTotals = (rows: [string, SheetCell][]) =>
      computeSheet(
        sheetOf(
          Object.fromEntries([
            ...rows,
            ["B1", formulaCell(`=SUM(A1:A${values.length})`)],
            ["B2", formulaCell(`=AVERAGE(A1:A${values.length})`)],
            ["B3", formulaCell(`=MIN(A1:A${values.length})+MAX(A1:A${values.length})`)],
          ]),
        ),
      );
    const a = withTotals(ordered);
    const b = withTotals(rotated);
    expect(b.B1).toEqual(a.B1);
    expect(b.B2).toEqual(a.B2);
    expect(b.B3).toEqual(a.B3);
  },
);

// A result is a finite number with at most 15 significant digits, or text, or one of five errors.
test.prop([number, number, fc.constantFrom("+", "-", "*", "/")])(
  "a result is always a clean value",
  (a, b, operator) => {
    const result = computeSheet(
      sheetOf(
        Object.fromEntries([
          ["A1", { value: a }],
          ["A2", { value: b }],
          ["A3", formulaCell(`=A1${operator}A2`)],
        ]),
      ),
    ).A3;
    expect(result).toBeDefined();
    if (result!.type === "number") {
      expect(Number.isFinite(result!.value)).toBe(true);
      expect(Object.is(result!.value, -0)).toBe(false);
      // The shortest text that reads back as this number has at most 15 digits.
      const digits = result!.value.toExponential().split("e")[0]!.replace(/[-.]/g, "");
      expect(digits.length).toBeLessThanOrEqual(15);
    } else {
      // Division by zero, or a quotient too large to be a number.
      const code = result!.type === "error" ? result!.code : "";
      expect(["#DIV/0!", "#VALUE!"]).toContain(code);
      if (code === "#DIV/0!") expect(b === 0).toBe(true);
    }
  },
);
