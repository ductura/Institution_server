import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_SHEET_CELLS,
  columnLabel,
  filledCellCount,
  formatCellRef,
  parseCellRef,
  sheetDigest,
  sheetDocumentsEqual,
  sheetJcsBytes,
  validateSheetDocument,
  type SheetDocument,
} from "./index.ts";

// Golden vectors (val 14 decision 2). Derived outside this code; compared as
// written, never regenerated from the code under test. The web repository
// keeps the same file byte for byte.
type Accepted = { name: string; value: unknown; utf8Hex: string; sha256: string };
type Rejected = { name: string; value: unknown; errors: [string, string][] };

const VECTORS = (() => {
  const bytes = readFileSync(new URL("./golden-vectors.json", import.meta.url));
  if (bytes.some((byte) => byte > 0x7e || byte === 0x0d))
    throw new Error("vectors must be ASCII with LF");
  return JSON.parse(bytes.toString("latin1")) as {
    sheetDocuments: Accepted[];
    rejectedSheetDocuments: Rejected[];
  };
})();

const A1 = "A1";
const A2 = "A2";
const B1 = "B1";
const B2 = "B2";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function oneSheet(cells: Record<string, unknown>, rows = 200, columns = 26): unknown {
  return {
    schemaVersion: 1,
    kind: "spreadsheet",
    sheets: [{ id: ID_A, name: "List1", rows, columns, cells }],
  };
}

function valid(raw: unknown): SheetDocument {
  const outcome = validateSheetDocument(raw);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
  return outcome.doc;
}

describe("golden vectors of the spreadsheet document", () => {
  it.each(VECTORS.sheetDocuments)("$name is accepted with the same bytes and hash", (vector) => {
    const bytes = Buffer.from(vector.utf8Hex, "hex");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    const doc = valid(vector.value);
    expect(Buffer.from(sheetJcsBytes(doc)).toString("hex")).toBe(vector.utf8Hex);
    expect(sheetDigest(doc)).toBe(vector.sha256);
    // The bytes themselves parse back to the same document.
    const reparsed = valid(JSON.parse(bytes.toString("utf8")));
    expect(sheetDocumentsEqual(doc, reparsed)).toBe(true);
    expect(sheetDigest(reparsed)).toBe(vector.sha256);
  });

  it.each(VECTORS.rejectedSheetDocuments)("$name is refused with exactly its errors", (vector) => {
    const outcome = validateSheetDocument(vector.value);
    expect(outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code])).toEqual(
      vector.errors,
    );
  });

  it("covers every error code the validator can report", () => {
    const seen = new Set(VECTORS.rejectedSheetDocuments.flatMap((v) => v.errors.map((e) => e[1])));
    // CELLS_TOO_MANY and the duplicate checks of a huge document are in the tests below.
    expect([...seen].sort()).toEqual(
      [
        "SHEET_NOT_OBJECT",
        "SHEET_FIELD_UNKNOWN",
        "SHEET_VERSION_INVALID",
        "SHEET_KIND_INVALID",
        "SHEET_LIST_INVALID",
        "SHEET_ID_INVALID",
        "SHEET_ID_DUPLICATE",
        "SHEET_NAME_INVALID",
        "SHEET_NAME_DUPLICATE",
        "SHEET_ROWS_INVALID",
        "SHEET_COLUMNS_INVALID",
        "SHEET_CELLS_INVALID",
        "CELL_REF_INVALID",
        "CELL_OUT_OF_GRID",
        "CELL_NOT_OBJECT",
        "CELL_FIELD_UNKNOWN",
        "CELL_VALUE_INVALID",
        "CELL_FORMULA_INVALID",
        "CELL_EMPTY",
      ].sort(),
    );
  });
});

describe("limits and hostile input", () => {
  it("accepts exactly 3000 filled cells and refuses 3001", () => {
    const cells = (count: number): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) {
        out[formatCellRef((i % 26) + 1, Math.floor(i / 26) + 1)!] = { value: i };
      }
      return out;
    };
    const ok = valid(oneSheet(cells(MAX_SHEET_CELLS)));
    expect(filledCellCount(ok)).toBe(3000);
    const refused = validateSheetDocument(oneSheet(cells(MAX_SHEET_CELLS + 1)));
    expect(refused.ok ? [] : refused.errors).toEqual([
      { path: "$.sheets", code: "CELLS_TOO_MANY" },
    ]);
  });

  it("counts filled cells across sheets, not per sheet", () => {
    const fill = (count: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          formatCellRef((i % 26) + 1, Math.floor(i / 26) + 1)!,
          { value: 1 },
        ]),
      );
    const doc = {
      schemaVersion: 1,
      kind: "spreadsheet",
      sheets: [
        { id: ID_A, name: "Prvi", rows: 200, columns: 26, cells: fill(1500) },
        { id: ID_B, name: "Drugi", rows: 200, columns: 26, cells: fill(1501) },
      ],
    };
    const outcome = validateSheetDocument(doc);
    expect(outcome.ok ? [] : outcome.errors).toEqual([
      { path: "$.sheets", code: "CELLS_TOO_MANY" },
    ]);
  });

  it("refuses more cell keys than a grid can hold before reading them", () => {
    const cells: Record<string, unknown> = {};
    for (let i = 0; i < 5201; i += 1) cells[`k${i}`] = { value: 1 };
    const outcome = validateSheetDocument(oneSheet(cells));
    expect(outcome.ok ? [] : outcome.errors).toEqual([
      { path: "$.sheets[0].cells", code: "CELLS_TOO_MANY" },
    ]);
  });

  it("refuses prototype keys and non-plain objects instead of reading them", () => {
    const proto = JSON.parse('{"__proto__":{"value":"x"}}') as unknown;
    const outcome = validateSheetDocument(oneSheet(proto as Record<string, unknown>));
    expect(outcome.ok ? [] : outcome.errors.map((e) => e.code)).toEqual(["CELL_REF_INVALID"]);
    expect(validateSheetDocument(new Map()).ok).toBe(false);
    expect(validateSheetDocument(null).ok).toBe(false);
    expect(validateSheetDocument("text").ok).toBe(false);
    expect(validateSheetDocument(Object.create({ schemaVersion: 1 })).ok).toBe(false);
  });

  it("refuses numbers JSON cannot carry and negative zero", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      expect(validateSheetDocument(oneSheet({ [A1]: { value: bad } })).ok).toBe(false);
    }
    expect(validateSheetDocument(oneSheet({ [A1]: { value: Number.MAX_VALUE } })).ok).toBe(true);
  });

  it("refuses a lone surrogate in text, in a name and in a formula", () => {
    expect(validateSheetDocument(oneSheet({ [A1]: { value: "a\ud800" } })).ok).toBe(false);
    expect(validateSheetDocument(oneSheet({ [A1]: { value: null, formula: "=\udc00" } })).ok).toBe(
      false,
    );
    const named = {
      schemaVersion: 1,
      kind: "spreadsheet",
      sheets: [{ id: ID_A, name: "\ud83d", rows: 1, columns: 1, cells: {} }],
    };
    expect(validateSheetDocument(named).ok).toBe(false);
  });

  it("counts an astral character as one code point in the limits", () => {
    expect(validateSheetDocument(oneSheet({ [A1]: { value: "\u{1F600}".repeat(1000) } })).ok).toBe(
      true,
    );
    expect(validateSheetDocument(oneSheet({ [A1]: { value: "\u{1F600}".repeat(1001) } })).ok).toBe(
      false,
    );
    const name = (text: string) => ({
      schemaVersion: 1,
      kind: "spreadsheet",
      sheets: [{ id: ID_A, name: text, rows: 1, columns: 1, cells: {} }],
    });
    expect(validateSheetDocument(name("\u{1F600}".repeat(31))).ok).toBe(true);
    expect(validateSheetDocument(name("\u{1F600}".repeat(32))).ok).toBe(false);
  });

  it("does not copy an unknown field into the document, even in a refused-then-fixed copy", () => {
    const doc = valid(oneSheet({ [A1]: { value: "x" } }));
    expect(Object.keys(doc).sort()).toEqual(["kind", "schemaVersion", "sheets"]);
    expect(Object.keys(doc.sheets[0]!).sort()).toEqual(["cells", "columns", "id", "name", "rows"]);
  });

  it("does not alias the input: changing it afterwards leaves the valid document alone", () => {
    const raw = oneSheet({ [A1]: { value: "x" } }) as {
      sheets: { cells: Record<string, { value: string }> }[];
    };
    const doc = valid(raw);
    raw.sheets[0]!.cells.A1!.value = "y";
    expect(doc.sheets[0]!.cells.A1).toEqual({ value: "x" });
  });
});

describe("digest and equality", () => {
  it("does not depend on the order of the keys of the input", () => {
    const one = valid(oneSheet({ [A1]: { value: 1 }, [B2]: { value: null, formula: "=A1" } }));
    const two = valid(oneSheet({ [B2]: { formula: "=A1", value: null }, [A1]: { value: 1 } }));
    expect(sheetDigest(one)).toBe(sheetDigest(two));
    expect(sheetDocumentsEqual(one, two)).toBe(true);
  });

  it("tells apart the number 1 from the text 1, a formula from its text, and the order of sheets", () => {
    const number = valid(oneSheet({ [A1]: { value: 1 } }));
    const text = valid(oneSheet({ [A1]: { value: "1" } }));
    const formula = valid(oneSheet({ [A1]: { value: null, formula: "=1" } }));
    expect(sheetDocumentsEqual(number, text)).toBe(false);
    expect(sheetDocumentsEqual(number, formula)).toBe(false);
    expect(new Set([sheetDigest(number), sheetDigest(text), sheetDigest(formula)]).size).toBe(3);
    const two = (first: string, second: string) =>
      valid({
        schemaVersion: 1,
        kind: "spreadsheet",
        sheets: [
          { id: first, name: first === ID_A ? "Prvi" : "Drugi", rows: 1, columns: 1, cells: {} },
          { id: second, name: second === ID_A ? "Prvi" : "Drugi", rows: 1, columns: 1, cells: {} },
        ],
      });
    expect(sheetDocumentsEqual(two(ID_A, ID_B), two(ID_B, ID_A))).toBe(false);
  });

  it("tells apart a changed cell, a changed grid and a cell moved to another reference", () => {
    const base = valid(oneSheet({ [A1]: { value: "x" } }, 5, 5));
    expect(sheetDocumentsEqual(base, valid(oneSheet({ [A1]: { value: "y" } }, 5, 5)))).toBe(false);
    expect(sheetDocumentsEqual(base, valid(oneSheet({ [A1]: { value: "x" } }, 6, 5)))).toBe(false);
    expect(sheetDocumentsEqual(base, valid(oneSheet({ [B1]: { value: "x" } }, 5, 5)))).toBe(false);
    expect(
      sheetDocumentsEqual(
        base,
        valid(oneSheet({ [A1]: { value: "x" }, [A2]: { value: "x" } }, 5, 5)),
      ),
    ).toBe(false);
    expect(sheetDocumentsEqual(base, valid(oneSheet({ [A1]: { value: "x" } }, 5, 5)))).toBe(true);
  });
});

describe("A1 references", () => {
  it("round-trips every reference of the largest grid", () => {
    for (let column = 1; column <= 26; column += 1) {
      for (let row = 1; row <= 200; row += 1) {
        const ref = formatCellRef(column, row)!;
        expect(parseCellRef(ref)).toEqual({ column, row });
      }
    }
  });

  it("refuses everything outside canonical A1 in the limits", () => {
    for (const bad of [
      "",
      "A",
      "1",
      "a1",
      "A0",
      "A01",
      "A201",
      "AA1",
      "A1 ",
      " A1",
      "A-1",
      "А" + "1",
    ]) {
      expect(parseCellRef(bad), bad).toBeNull();
    }
    expect(formatCellRef(0, 1)).toBeNull();
    expect(formatCellRef(27, 1)).toBeNull();
    expect(formatCellRef(1, 0)).toBeNull();
    expect(formatCellRef(1, 201)).toBeNull();
    expect(formatCellRef(1.5, 1)).toBeNull();
    expect(columnLabel(26)).toBe("Z");
    expect(columnLabel(27)).toBeNull();
  });
});
