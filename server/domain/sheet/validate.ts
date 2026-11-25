/**
 * Validation of the spreadsheet document v1 (limits: decision 2 of the val 14
 * review). Nothing is repaired: any problem is an error with its path, and a
 * valid document is copied from known fields only, so an unknown field is
 * refused and can never reach the canonical form (as B-8 for the text
 * document). The formula text is checked for length and characters only; its
 * syntax belongs to the formula computer.
 */

import { createHash } from "node:crypto";

import { jcsUtf8Bytes } from "../forensics/index.ts";
import { isPlainObject } from "../json/index.ts";
import { isForbiddenCodePoint, isWhiteSpaceCodePoint } from "../document/index.ts";
import {
  MAX_CELL_TEXT_CODE_POINTS,
  MAX_FORMULA_CODE_POINTS,
  MAX_SHEETS,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_NAME_CODE_POINTS,
  MAX_SHEET_ROWS,
  SHEET_KIND,
  SHEET_SCHEMA_VERSION,
  isSheetId,
  parseCellRef,
  type Sheet,
  type SheetCell,
  type SheetCells,
  type SheetDocument,
} from "./schema.ts";

export const SHEET_VALIDATION_CODES = [
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
  "CELLS_TOO_MANY",
] as const;
export type SheetValidationCode = (typeof SHEET_VALIDATION_CODES)[number];
export type SheetValidationError = { path: string; code: SheetValidationCode };
export type SheetValidation =
  { ok: true; doc: SheetDocument } | { ok: false; errors: SheetValidationError[] };

type Raw = Record<string, unknown>;

const DOCUMENT_FIELDS = new Set(["schemaVersion", "kind", "sheets"]);
const SHEET_FIELDS = new Set(["id", "name", "rows", "columns", "cells"]);
const CELL_FIELDS = new Set(["value", "formula"]);
// Characters of a sheet name that the .xlsx format refuses.
const NAME_REFUSED = /[:\\/?*[\]]/;
// A cell may hold line breaks and tabs (a pasted paragraph); every other
// FORBIDDEN code point is refused as in the text document.
const CELL_TEXT_ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

/**
 * Code points of `value`, or `null` for a lone surrogate or a refused code
 * point. `allowed` lists control code points that stay legal for this field.
 */
function codePoints(value: string, allowed: ReadonlySet<number>): number | null {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      codePoint = (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
    if (isForbiddenCodePoint(codePoint) && !allowed.has(codePoint)) return null;
    count += 1;
  }
  return count;
}

const NO_CONTROLS: ReadonlySet<number> = new Set();

function inRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= min &&
    value <= max
  );
}

function unknownFields(
  raw: Raw,
  allowed: ReadonlySet<string>,
  path: string,
  code: SheetValidationCode,
  errors: SheetValidationError[],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, code });
  }
}

function isSheetName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = codePoints(value, NO_CONTROLS);
  return (
    length !== null &&
    length >= 1 &&
    length <= MAX_SHEET_NAME_CODE_POINTS &&
    !isWhiteSpaceCodePoint(value.charCodeAt(0)) &&
    !isWhiteSpaceCodePoint(value.charCodeAt(value.length - 1)) &&
    !NAME_REFUSED.test(value) &&
    // Excel refuses a name that starts or ends with an apostrophe.
    !value.startsWith("'") &&
    !value.endsWith("'")
  );
}

function isCellText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = codePoints(value, CELL_TEXT_ALLOWED_CONTROLS);
  return length !== null && length >= 1 && length <= MAX_CELL_TEXT_CODE_POINTS;
}

function isFormulaText(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("=")) return false;
  const length = codePoints(value, NO_CONTROLS);
  return length !== null && length >= 2 && length <= MAX_FORMULA_CODE_POINTS;
}

/** A finite number that is not -0: the one number form JSON and the canonical form share. */
function isCellNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}

function validateCell(
  raw: unknown,
  path: string,
  errors: SheetValidationError[],
): SheetCell | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "CELL_NOT_OBJECT" });
    return null;
  }
  const before = errors.length;
  unknownFields(raw, CELL_FIELDS, path, "CELL_FIELD_UNKNOWN", errors);
  const hasFormula = Object.hasOwn(raw, "formula");
  const value = Object.hasOwn(raw, "value") ? raw.value : undefined;
  if (hasFormula) {
    if (!isFormulaText(raw.formula))
      errors.push({ path: `${path}.formula`, code: "CELL_FORMULA_INVALID" });
    // The result of a formula is not stored; the value is exactly null.
    if (value !== null) errors.push({ path: `${path}.value`, code: "CELL_VALUE_INVALID" });
  } else if (value === null) {
    // No value and no formula is an empty cell, and an empty cell is absent.
    errors.push({ path, code: "CELL_EMPTY" });
  } else if (!(isCellText(value) || isCellNumber(value))) {
    errors.push({ path: `${path}.value`, code: "CELL_VALUE_INVALID" });
  }
  if (errors.length > before) return null;
  if (hasFormula) return { value: null, formula: raw.formula as string };
  return { value: value as string | number };
}

function validateCells(
  raw: unknown,
  path: string,
  rows: number | null,
  columns: number | null,
  errors: SheetValidationError[],
): { cells: SheetCells; filled: number } | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "SHEET_CELLS_INVALID" });
    return null;
  }
  const keys = Object.keys(raw);
  // The most a grid can hold is 26 x 200 cells; more keys is refused before any is read.
  if (keys.length > MAX_SHEET_ROWS * MAX_SHEET_COLUMNS) {
    errors.push({ path, code: "CELLS_TOO_MANY" });
    return null;
  }
  const before = errors.length;
  const cells: SheetCells = {};
  for (const key of keys) {
    const cellPath = `${path}.${key}`;
    const ref = parseCellRef(key);
    if (ref === null) {
      errors.push({ path: cellPath, code: "CELL_REF_INVALID" });
      continue;
    }
    if (rows !== null && columns !== null && (ref.row > rows || ref.column > columns)) {
      errors.push({ path: cellPath, code: "CELL_OUT_OF_GRID" });
    }
    const cell = validateCell(raw[key], cellPath, errors);
    if (cell !== null) cells[key] = cell;
  }
  return errors.length > before ? null : { cells, filled: keys.length };
}

function validateSheet(
  raw: unknown,
  path: string,
  errors: SheetValidationError[],
): { sheet: Sheet; filled: number } | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "SHEET_NOT_OBJECT" });
    return null;
  }
  const before = errors.length;
  unknownFields(raw, SHEET_FIELDS, path, "SHEET_FIELD_UNKNOWN", errors);
  const id = raw.id;
  if (!isSheetId(id)) errors.push({ path: `${path}.id`, code: "SHEET_ID_INVALID" });
  const name = raw.name;
  if (!isSheetName(name)) errors.push({ path: `${path}.name`, code: "SHEET_NAME_INVALID" });
  const rowsOk = inRange(raw.rows, 1, MAX_SHEET_ROWS);
  if (!rowsOk) errors.push({ path: `${path}.rows`, code: "SHEET_ROWS_INVALID" });
  const columnsOk = inRange(raw.columns, 1, MAX_SHEET_COLUMNS);
  if (!columnsOk) errors.push({ path: `${path}.columns`, code: "SHEET_COLUMNS_INVALID" });
  const cells = validateCells(
    raw.cells,
    `${path}.cells`,
    rowsOk ? (raw.rows as number) : null,
    columnsOk ? (raw.columns as number) : null,
    errors,
  );
  if (errors.length > before || cells === null) return null;
  return {
    sheet: {
      id: id as string,
      name: name as string,
      rows: raw.rows as number,
      columns: raw.columns as number,
      cells: cells.cells,
    },
    filled: cells.filled,
  };
}

export function validateSheetDocument(raw: unknown): SheetValidation {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ path: "$", code: "SHEET_NOT_OBJECT" }] };
  const errors: SheetValidationError[] = [];
  unknownFields(raw, DOCUMENT_FIELDS, "$", "SHEET_FIELD_UNKNOWN", errors);
  if (raw.schemaVersion !== SHEET_SCHEMA_VERSION) {
    errors.push({ path: "$.schemaVersion", code: "SHEET_VERSION_INVALID" });
  }
  if (raw.kind !== SHEET_KIND) errors.push({ path: "$.kind", code: "SHEET_KIND_INVALID" });
  const sheets: Sheet[] = [];
  let filled = 0;
  if (!Array.isArray(raw.sheets) || raw.sheets.length < 1 || raw.sheets.length > MAX_SHEETS) {
    errors.push({ path: "$.sheets", code: "SHEET_LIST_INVALID" });
  } else {
    const ids = new Set<string>();
    const names = new Set<string>();
    raw.sheets.forEach((item: unknown, index: number) => {
      const path = `$.sheets[${index}]`;
      const outcome = validateSheet(item, path, errors);
      if (outcome === null) return;
      filled += outcome.filled;
      if (ids.has(outcome.sheet.id))
        errors.push({ path: `${path}.id`, code: "SHEET_ID_DUPLICATE" });
      ids.add(outcome.sheet.id);
      // Names are unique without regard to case, as in a workbook.
      const folded = outcome.sheet.name.toLowerCase();
      if (names.has(folded)) errors.push({ path: `${path}.name`, code: "SHEET_NAME_DUPLICATE" });
      names.add(folded);
      sheets.push(outcome.sheet);
    });
  }
  if (filled > MAX_SHEET_CELLS) errors.push({ path: "$.sheets", code: "CELLS_TOO_MANY" });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { schemaVersion: SHEET_SCHEMA_VERSION, kind: SHEET_KIND, sheets } };
}

/** Filled cells of the whole document: every cell in `cells` is filled, an empty one is absent. */
export function filledCellCount(doc: SheetDocument): number {
  return doc.sheets.reduce((total, sheet) => total + Object.keys(sheet.cells).length, 0);
}

/** The canonical bytes of a valid document: JCS (RFC 8785), as for the text document. */
export function sheetJcsBytes(doc: SheetDocument): Uint8Array {
  return jcsUtf8Bytes(doc);
}

/** Lowercase hex SHA-256 of the canonical bytes. */
export function sheetDigest(doc: SheetDocument): string {
  return createHash("sha256").update(sheetJcsBytes(doc)).digest("hex");
}

/**
 * Equality of two valid documents, field by field and in order of sheets (the
 * order of the sheets is part of the document). A formula cell never equals a
 * value cell, and the number 1 never equals the text "1".
 */
export function sheetDocumentsEqual(a: SheetDocument, b: SheetDocument): boolean {
  if (a.sheets.length !== b.sheets.length) return false;
  return a.sheets.every((left, index) => {
    const right = b.sheets[index]!;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.rows !== right.rows ||
      left.columns !== right.columns
    ) {
      return false;
    }
    const keys = Object.keys(left.cells);
    if (keys.length !== Object.keys(right.cells).length) return false;
    return keys.every((key) => {
      const l = left.cells[key]!;
      const r = Object.hasOwn(right.cells, key) ? right.cells[key]! : undefined;
      return r !== undefined && Object.is(l.value, r.value) && l.formula === r.formula;
    });
  });
}
