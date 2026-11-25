import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_RANGE_CELLS,
  computeSheet,
  computeSheetDocument,
  parseFormula,
  roundResult,
  roundToDecimals,
  type ComputedCell,
  type FormulaParseCode,
} from "./index.ts";
import type { Sheet, SheetCell } from "../index.ts";

// Vectors worked out by hand from README.md, never produced by this code. The
// web repository keeps the same file byte for byte.
type Expected = { n: number } | { t: string } | { e: string };
type Vector = {
  name: string;
  rows?: number;
  columns?: number;
  cells: Record<string, { value?: string | number; formula?: string }>;
  expect: Record<string, Expected>;
};

const VECTORS = (() => {
  const bytes = readFileSync(new URL("./formula-vectors.json", import.meta.url));
  if (bytes.some((byte) => byte > 0x7e || byte === 0x0d))
    throw new Error("vectors must be ASCII with LF");
  return JSON.parse(bytes.toString("latin1")) as { vectors: Vector[] };
})();

const SHEET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sheetOf(cells: Record<string, SheetCell>, rows = 200, columns = 26): Sheet {
  return { id: SHEET_ID, name: "List1", rows, columns, cells };
}

function cellOf(raw: { value?: string | number; formula?: string }): SheetCell {
  return raw.formula === undefined
    ? { value: raw.value ?? "" }
    : { value: null, formula: raw.formula };
}

function formulaCell(formula: string): SheetCell {
  return { value: null, formula };
}

function toComputed(expected: Expected): ComputedCell {
  if ("n" in expected) return { type: "number", value: expected.n };
  if ("t" in expected) return { type: "text", value: expected.t };
  return { type: "error", code: expected.e } as ComputedCell;
}

function resultOf(
  formula: string,
  cells: Record<string, SheetCell> = {},
): ComputedCell | undefined {
  return computeSheet(sheetOf({ ...cells, ...Object.fromEntries([["Z1", formulaCell(formula)]]) }))
    .Z1;
}

describe("formula vectors", () => {
  it("has the vectors the review asks for", () => {
    expect(VECTORS.vectors.length).toBeGreaterThan(100);
    const names = VECTORS.vectors.map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const vector of VECTORS.vectors) {
    it(vector.name, () => {
      const cells = Object.fromEntries(
        Object.entries(vector.cells).map(([ref, raw]) => [ref, cellOf(raw)]),
      );
      const computed = computeSheet(sheetOf(cells, vector.rows, vector.columns));
      for (const [ref, expected] of Object.entries(vector.expect)) {
        const want = toComputed(expected);
        expect(computed[ref], ref).toEqual(want);
        if (want.type === "number")
          expect(
            Object.is(
              computed[ref] && "value" in computed[ref] ? computed[ref].value : NaN,
              want.value,
            ),
            `${ref} is not -0`,
          ).toBe(true);
      }
    });
  }
});

describe("limits", () => {
  const codeOf = (formula: string): FormulaParseCode | "ok" => {
    const parsed = parseFormula(formula);
    return parsed.ok ? "ok" : parsed.code;
  };

  it("refuses text that is not a formula and over-long formulas", () => {
    expect(codeOf("1+1")).toBe("FORMULA_PREFIX");
    expect(codeOf("=1" + "+1".repeat(249))).toBe("ok");
    expect(codeOf("=1" + "+1".repeat(250))).toBe("FORMULA_TOO_LONG");
    expect(resultOf("=1" + "+1".repeat(250))).toEqual({ type: "error", code: "#VALUE!" });
    expect(resultOf("=1" + "+1".repeat(249))).toEqual({ type: "number", value: 250 });
  });

  it("counts the length in code points, not in UTF-16 units", () => {
    const emoji = "\u{1F600}".repeat(250);
    expect(codeOf(`="${emoji}"`)).toBe("ok");
    expect(codeOf(`="${emoji}${"\u{1F600}".repeat(250)}"`)).toBe("FORMULA_TOO_LONG");
  });

  it("refuses expressions nested deeper than the limit", () => {
    const nested = (levels: number) => `=${"(".repeat(levels)}1${")".repeat(levels)}`;
    expect(codeOf(nested(MAX_FORMULA_DEPTH - 1))).toBe("ok");
    expect(codeOf(nested(MAX_FORMULA_DEPTH))).toBe("FORMULA_TOO_DEEP");
    expect(codeOf(`=${"-".repeat(MAX_FORMULA_DEPTH - 1)}1`)).toBe("ok");
    expect(codeOf(`=${"-".repeat(MAX_FORMULA_DEPTH)}1`)).toBe("FORMULA_TOO_DEEP");
    expect(codeOf(`=${"SUM(".repeat(MAX_FORMULA_DEPTH)}1${")".repeat(MAX_FORMULA_DEPTH)}`)).toBe(
      "FORMULA_TOO_DEEP",
    );
    expect(resultOf(nested(MAX_FORMULA_DEPTH))).toEqual({ type: "error", code: "#VALUE!" });
  });

  it("refuses ranges that name more than 10 000 cells in one formula", () => {
    expect(MAX_FORMULA_RANGE_CELLS).toBe(10_000);
    expect(codeOf("=SUM(A1:Z200)")).toBe("ok");
    expect(codeOf("=SUM(A1:Z200,A1:Z184)")).toBe("ok");
    expect(codeOf("=SUM(A1:Z200,A1:Z185)")).toBe("FORMULA_RANGE_TOO_LARGE");
    expect(resultOf("=SUM(A1:Z200,A1:Z200)")).toEqual({ type: "error", code: "#VALUE!" });
  });

  it("refuses a literal that is not a finite number", () => {
    expect(codeOf(`=${"9".repeat(400)}`)).toBe("FORMULA_SYNTAX");
  });
});

describe("rounding", () => {
  it("rounds half away from zero on the shortest decimal text", () => {
    expect(roundToDecimals(2.675, 2)).toBe(2.68);
    expect(roundToDecimals(-2.675, 2)).toBe(-2.68);
    expect(roundToDecimals(0.285, 2)).toBe(0.29);
    expect(roundToDecimals(1e21 + 0, 2)).toBe(1e21);
    expect(Object.is(roundToDecimals(-0.001, 2), 0)).toBe(true);
  });

  it("keeps 15 significant digits in a result", () => {
    expect(roundResult(0.1 + 0.2)).toBe(0.3);
    expect(roundResult(123456789.123456789)).toBe(123456789.123457);
    expect(roundResult(5e-324)).toBe(5e-324);
    expect(roundResult(Number.MAX_VALUE)).toBe(1.79769313486231e308);
    expect(roundResult(-Number.MAX_VALUE)).toBe(-1.79769313486231e308);
    expect(roundResult(9.999999999999999e22)).toBe(1e23);
  });
});

describe("computing a document", () => {
  it("gives the results of every sheet in order, and only for filled cells", () => {
    const first = sheetOf(
      Object.fromEntries([
        ["A1", { value: 2 }],
        ["B1", formulaCell("=A1*A1")],
      ]),
    );
    const second = {
      ...sheetOf(Object.fromEntries([["A1", { value: "x" }]])),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "List2",
    };
    const results = computeSheetDocument({
      schemaVersion: 1,
      kind: "spreadsheet",
      sheets: [first, second],
    });
    expect(results).toEqual([
      {
        sheetId: first.id,
        cells: Object.fromEntries([
          ["A1", { type: "number", value: 2 }],
          ["B1", { type: "number", value: 4 }],
        ]),
      },
      { sheetId: second.id, cells: Object.fromEntries([["A1", { type: "text", value: "x" }]]) },
    ]);
  });

  it("does not store anything in the sheet and never reads the stored result of a formula", () => {
    const sheet = sheetOf(
      Object.fromEntries([
        ["A1", { value: 3 }],
        ["A2", formulaCell("=A1+1")],
      ]),
    );
    const before = JSON.stringify(sheet);
    computeSheet(sheet);
    expect(JSON.stringify(sheet)).toBe(before);
  });

  it("handles a long chain of formulas without deep recursion", () => {
    const cells: Record<string, SheetCell> = Object.fromEntries([["A1", { value: 1 }]]);
    for (let row = 2; row <= 200; row += 1) cells[`A${row}`] = formulaCell(`=A${row - 1}+1`);
    expect(computeSheet(sheetOf(cells)).A200).toEqual({ type: "number", value: 200 });
  });
});
