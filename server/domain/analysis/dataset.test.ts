import { describe, expect, it } from "vitest";

import { DATASET_LIMITS, MAX_ABS_NUMBER, validateDataset, type DatasetProblem } from "./dataset.ts";

// All data here is invented.
const COLUMNS = [
  { name: "sati", kind: "numeric" },
  { name: "grupa", kind: "category" },
];
const ROWS = [
  [1.5, "a"],
  [2, "b"],
  [null, null],
];
const good = () => ({ columns: structuredClone(COLUMNS), rows: structuredClone(ROWS) });

function problemOf(input: unknown): DatasetProblem | undefined {
  const result = validateDataset(input);
  return result.ok ? undefined : result.error.problem;
}

describe("validateDataset: accepts", () => {
  it("a good dataset, with null for a missing cell", () => {
    const result = validateDataset(good());
    expect(result.ok && result.value.rows).toEqual(ROWS);
  });

  it("returns a deep-frozen copy that does not alias the input", () => {
    const input = good();
    const result = validateDataset(input);
    if (!result.ok) throw new Error("expected ok");
    input.rows[0]![0] = 99;
    expect(result.value.rows[0]![0]).toBe(1.5);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.columns)).toBe(true);
    expect(Object.isFrozen(result.value.columns[0])).toBe(true);
    expect(Object.isFrozen(result.value.rows)).toBe(true);
    expect(Object.isFrozen(result.value.rows[0])).toBe(true);
  });

  it("treats -0 as 0", () => {
    const result = validateDataset({ columns: [COLUMNS[0]], rows: [[-0]] });
    expect(result.ok && Object.is(result.value.rows[0]![0], 0)).toBe(true);
  });

  it("takes a very large number up to the bound and Croatian letters", () => {
    const result = validateDataset({
      columns: [COLUMNS[0], { name: "čćšžđ", kind: "category" }],
      rows: [[MAX_ABS_NUMBER, "đurđevak"]],
    });
    expect(result.ok).toBe(true);
  });

  it("counts length in code points, so 64 emoji fit and 65 do not", () => {
    const col = [{ name: "t", kind: "category" }];
    expect(validateDataset({ columns: col, rows: [["😀".repeat(64)]] }).ok).toBe(true);
    expect(problemOf({ columns: col, rows: [["😀".repeat(65)]] })).toBe("cell_too_long");
  });

  it("takes exactly the limits: 500 rows, 12 columns, 40-character name", () => {
    const columns = Array.from({ length: 12 }, (_, i) => ({
      name: i === 0 ? "x".repeat(40) : `s${i}`,
      kind: "numeric",
    }));
    const rows = Array.from({ length: 500 }, () => columns.map(() => 1));
    expect(validateDataset({ columns, rows }).ok).toBe(true);
  });
});

describe("validateDataset: refuses, never throws", () => {
  it.each([
    ["null", null, "not_an_object"],
    ["array", [], "not_an_object"],
    ["string", "x", "not_an_object"],
    ["class instance", new Date(), "not_an_object"],
    ["unknown field", { ...good(), extra: 1 }, "unknown_field"],
    ["empty rows", { columns: COLUMNS, rows: [] }, "no_rows"],
    ["empty columns", { columns: [], rows: [] }, "no_columns"],
    ["columns not an array", { columns: {}, rows: [] }, "columns_invalid"],
    ["rows missing", { columns: COLUMNS }, "rows_invalid"],
    ["row not an array", { columns: COLUMNS, rows: ["ab"] }, "row_invalid"],
    ["short row", { columns: COLUMNS, rows: [[1]] }, "row_length_mismatch"],
    ["long row", { columns: COLUMNS, rows: [[1, "a", 2]] }, "row_length_mismatch"],
    ["text in numeric column", { columns: COLUMNS, rows: [["1", "a"]] }, "cell_not_numeric"],
    ["number in category column", { columns: COLUMNS, rows: [[1, 2]] }, "cell_not_text"],
    ["boolean cell", { columns: COLUMNS, rows: [[true, "a"]] }, "cell_not_numeric"],
    ["undefined cell", { columns: COLUMNS, rows: [[undefined, "a"]] }, "cell_not_numeric"],
    ["NaN", { columns: COLUMNS, rows: [[NaN, "a"]] }, "cell_not_finite"],
    ["Infinity", { columns: COLUMNS, rows: [[Infinity, "a"]] }, "cell_not_finite"],
    ["-Infinity", { columns: COLUMNS, rows: [[-Infinity, "a"]] }, "cell_not_finite"],
    ["too large", { columns: COLUMNS, rows: [[1e308, "a"]] }, "cell_too_large"],
    ["empty text", { columns: COLUMNS, rows: [[1, ""]] }, "cell_empty_text"],
    ["65-character text", { columns: COLUMNS, rows: [[1, "a".repeat(65)]] }, "cell_too_long"],
    ["lone surrogate", { columns: COLUMNS, rows: [[1, "\ud800"]] }, "text_invalid"],
    ["bad kind", { columns: [{ name: "a", kind: "text" }], rows: [[1]] }, "column_kind_invalid"],
    [
      "column unknown field",
      { columns: [{ name: "a", kind: "numeric", x: 1 }], rows: [[1]] },
      "unknown_field",
    ],
    [
      "empty name",
      { columns: [{ name: "", kind: "numeric" }], rows: [[1]] },
      "column_name_invalid",
    ],
    [
      "non-string name",
      { columns: [{ name: 1, kind: "numeric" }], rows: [[1]] },
      "column_name_invalid",
    ],
    [
      "41-character name",
      { columns: [{ name: "x".repeat(41), kind: "numeric" }], rows: [[1]] },
      "column_name_too_long",
    ],
    [
      "duplicate name",
      { columns: [COLUMNS[0], COLUMNS[0]], rows: [[1, 1]] },
      "column_name_duplicate",
    ],
  ] as const)("%s", (_name, input, problem) => {
    expect(problemOf(input)).toBe(problem);
  });

  it("refuses 501 rows and 13 columns", () => {
    expect(problemOf({ columns: [COLUMNS[0]], rows: Array.from({ length: 501 }, () => [1]) })).toBe(
      "too_many_rows",
    );
    const columns = Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, kind: "numeric" }));
    expect(problemOf({ columns, rows: [columns.map(() => 1)] })).toBe("too_many_columns");
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses the column name %s", (name) => {
    expect(problemOf({ columns: [{ name, kind: "numeric" }], rows: [[1]] })).toBe(
      "column_name_invalid",
    );
  });

  it("refuses a prototype key arriving through JSON.parse", () => {
    expect(problemOf(JSON.parse('{"columns":[],"rows":[],"__proto__":{"x":1}}'))).toBe(
      "unknown_field",
    );
    expect(
      problemOf(
        JSON.parse('{"columns":[{"name":"a","kind":"numeric","__proto__":1}],"rows":[[1]]}'),
      ),
    ).toBe("unknown_field");
  });

  it("points at the row and column of the first problem", () => {
    const result = validateDataset({
      columns: COLUMNS,
      rows: [
        [1, "a"],
        [2, "b"],
        ["x", "c"],
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_input", problem: "cell_not_numeric", row: 2, column: 0 },
    });
  });

  it("does not throw on sparse arrays, getters or a hostile proxy", () => {
    expect(problemOf({ columns: COLUMNS, rows: [new Array(2)] })).toBe("row_invalid");
    const withGetter = { columns: COLUMNS, rows: [[1, "a"]] };
    Object.defineProperty(withGetter, "rows", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(problemOf(withGetter)).toBe("unreadable");
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom");
        },
      },
    );
    expect(problemOf(proxy)).toBe("unreadable");
  });

  it("does not change the input", () => {
    const input = good();
    const before = JSON.stringify(input);
    validateDataset(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("DATASET_LIMITS", () => {
  it("are the numbers of the contract §3.2", () => {
    expect(DATASET_LIMITS).toEqual({
      maxRows: 500,
      maxColumns: 12,
      maxCellLength: 64,
      maxColumnNameLength: 40,
      maxBodyBytes: 131072,
    });
  });
});
