import { describe, expect, it } from "vitest";

import { validateDocumentV4 } from "./validate-v4.ts";

// Document v4 table (docs/contracts/document-schema-v4.md §5.1, classes 56
// and 57; SRV-10A). Invented data only.

const P = "11111111-1111-4111-8111-111111111111";

const table = (fields: Record<string, unknown> = {}) => ({
  schemaVersion: 4,
  sources: [],
  nodes: [
    {
      type: "table",
      id: P,
      rows: [
        ["Grad", "Kućanstva", "Udio"],
        ["Izmišljeni Grad", "", "12 %"],
        ["Drugi Grad", "340", "9 %"],
      ],
      header: true,
      stripes: false,
      landscape: false,
      ...fields,
    },
  ],
});
const errorsOf = (value: unknown) => {
  const outcome = validateDocumentV4(value);
  return outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code]);
};
const accepts = (value: unknown) =>
  expect(validateDocumentV4(value)).toEqual({ ok: true, doc: value });
const at = (field: string, code: string) => [[`$.nodes[0]${field}`, code]];

describe("table rows and cells (class 56)", () => {
  it("accepts 1×1, 3000 cells, empty cells, edge spaces and every optional field", () => {
    accepts(table({ rows: [[""]] }));
    accepts(table({ rows: Array.from({ length: 1000 }, () => ["a", "b", "c"]) }));
    accepts(table({ rows: [["  razmak  ", "x".repeat(1000)]] }));
    accepts(
      table({
        headerFill: "#dce6f2",
        cellFills: [{ color: "#fff2cc", column: 1, row: 2 }],
        merges: [{ column: 1, columnSpan: 2, row: 1, rowSpan: 1 }],
        rows: [
          ["Grad", "Kućanstva", "Udio"],
          ["Izmišljeni Grad", "12 %", ""],
          ["Drugi Grad", "340", "9 %"],
        ],
        title: "Kućno kompostiranje po gradovima",
        source: "izrada autora",
      }),
    );
  });

  it("refuses an empty table, a ragged one, an empty row and more than 3000 cells", () => {
    for (const rows of [
      [],
      [[]],
      [["a", "b"], ["c"]],
      "a",
      [["a"], "b"],
      Array.from({ length: 1001 }, () => ["a", "b", "c"]),
    ]) {
      expect(errorsOf(table({ rows }))).toEqual(at(".rows", "TABLE_ROWS_INVALID"));
    }
    expect(errorsOf(table({ rows: undefined }))).toEqual(at(".rows", "TABLE_ROWS_INVALID"));
  });

  it("refuses a cell with a line break, a forbidden character, over 1000 code points or no text", () => {
    for (const cell of ["a\nb", "a​b", "x".repeat(1001), 7, null]) {
      expect(errorsOf(table({ rows: [["a", cell]] }))).toEqual(
        at(".rows[0][1]", "TABLE_CELL_INVALID"),
      );
    }
  });

  it("requires every flag as a JSON boolean", () => {
    for (const key of ["header", "stripes", "landscape"]) {
      expect(errorsOf(table({ [key]: 0 }))).toEqual(at(`.${key}`, "BLOCK_FLAG_INVALID"));
      expect(errorsOf(table({ [key]: undefined }))).toEqual(at(`.${key}`, "BLOCK_FLAG_INVALID"));
    }
  });

  it("refuses an untidy title or source and an unknown field", () => {
    expect(errorsOf(table({ title: " Naslov" }))).toEqual(at(".title", "FIGURE_TITLE_INVALID"));
    expect(errorsOf(table({ source: "x".repeat(501) }))).toEqual(
      at(".source", "FIGURE_SOURCE_INVALID"),
    );
    expect(errorsOf(table({ opt: {} }))).toEqual(at(".opt", "UNKNOWN_FIELD"));
  });
});

describe("table merges and fills (class 57)", () => {
  const merge = (row: number, column: number, rowSpan: number, columnSpan: number) => ({
    column,
    columnSpan,
    row,
    rowSpan,
  });
  const grid = [
    ["a", "", ""],
    ["", "", "b"],
    ["c", "d", "e"],
  ];

  it("accepts merges over empty cells in order", () => {
    accepts(table({ rows: grid, merges: [merge(0, 0, 2, 2)] }));
    accepts(table({ rows: grid, merges: [merge(0, 1, 1, 2), merge(1, 0, 1, 2)] }));
  });

  it("refuses an overlap, a merge outside the table, 1×1, wrong order and text under a merge", () => {
    const bad = [
      [merge(0, 0, 2, 2), merge(1, 1, 1, 1)],
      [merge(0, 0, 1, 3), merge(0, 1, 2, 1)],
      [merge(0, 1, 1, 3)],
      [merge(0, 0, 1, 1)],
      [merge(0, 0, 0, 2)],
      [merge(0, 0, 1, 2.5)],
      [merge(0, 0, 3, 1)],
    ];
    for (const merges of bad) {
      expect(errorsOf(table({ rows: grid, merges })).map(([, code]) => code)).toContain(
        "TABLE_MERGE_INVALID",
      );
    }
    expect(errorsOf(table({ rows: grid, merges: [merge(1, 0, 1, 2), merge(0, 1, 1, 2)] }))).toEqual(
      at(".merges[1]", "TABLE_MERGE_INVALID"),
    );
    expect(errorsOf(table({ rows: grid, merges: [] }))).toEqual(
      at(".merges", "TABLE_MERGE_INVALID"),
    );
    expect(errorsOf(table({ rows: grid, merges: [{ row: 0, column: 0, rowSpan: 2 }] }))).toEqual(
      at(".merges[0]", "TABLE_MERGE_INVALID"),
    );
  });

  it("refuses a fill of a covered cell, a repeated or unordered fill and a bad colour", () => {
    const fill = (row: number, column: number, color = "#fff2cc") => ({ color, column, row });
    expect(
      errorsOf(table({ rows: grid, merges: [merge(0, 0, 2, 2)], cellFills: [fill(1, 1)] })),
    ).toEqual(at(".cellFills[0]", "TABLE_FILL_INVALID"));
    accepts(table({ rows: grid, merges: [merge(0, 0, 2, 2)], cellFills: [fill(0, 0)] }));
    expect(errorsOf(table({ cellFills: [fill(1, 1), fill(1, 1)] }))).toEqual(
      at(".cellFills[1]", "TABLE_FILL_INVALID"),
    );
    expect(errorsOf(table({ cellFills: [fill(2, 0), fill(1, 2)] }))).toEqual(
      at(".cellFills[1]", "TABLE_FILL_INVALID"),
    );
    for (const color of ["#FFF2CC", "fff2cc", "#fff2cc80", "žuta"]) {
      expect(errorsOf(table({ cellFills: [fill(0, 0, color)] }))).toEqual(
        at(".cellFills[0]", "TABLE_FILL_INVALID"),
      );
    }
    expect(errorsOf(table({ cellFills: [fill(3, 0)] }))).toEqual(
      at(".cellFills[0]", "TABLE_FILL_INVALID"),
    );
  });

  it("allows headerFill only with a header", () => {
    expect(errorsOf(table({ header: false, headerFill: "#d9d9d9" }))).toEqual(
      at(".headerFill", "TABLE_FILL_INVALID"),
    );
    expect(errorsOf(table({ headerFill: "D9D9D9" }))).toEqual(
      at(".headerFill", "TABLE_FILL_INVALID"),
    );
  });
});
