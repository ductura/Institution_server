/**
 * The spreadsheet document, version 1 (Ductus val 14, SRV-V14-SHEET-MODEL).
 *
 * A work of kind `spreadsheet`: up to five sheets, each a grid of at most 200
 * rows by 26 columns. A cell is text, a number or a formula; an empty cell is
 * simply absent from `cells`. A formula cell stores no result: the result is
 * never the truth, the server computes it again (decision 4 of the val 14
 * review). This file holds the types, the limits and the A1 reference helpers
 * the formula computer builds on; `validate.ts` holds the checks.
 */

export const SHEET_SCHEMA_VERSION = 1;
export const SHEET_KIND = "spreadsheet";

export const MAX_SHEETS = 5;
export const MAX_SHEET_NAME_CODE_POINTS = 31;
export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLUMNS = 26;
/** Filled cells in the whole document, as `MAX_TABLE_CELLS` of the text table. */
export const MAX_SHEET_CELLS = 3000;
export const MAX_CELL_TEXT_CODE_POINTS = 1000;
export const MAX_FORMULA_CODE_POINTS = 500;

/** A cell holds text, a number, or a formula whose result is not stored. */
export type SheetCell =
  { value: string | number; formula?: undefined } | { value: null; formula: string };

export type SheetCells = Record<string, SheetCell>;

export type Sheet = {
  id: string;
  name: string;
  rows: number;
  columns: number;
  cells: SheetCells;
};

export type SheetDocument = {
  schemaVersion: typeof SHEET_SCHEMA_VERSION;
  kind: typeof SHEET_KIND;
  sheets: Sheet[];
};

// Lowercase RFC 4122 text (version 1-8, variant 8/9/a/b); the canonical form
// is lowercase, so an uppercase id is refused rather than folded.
const SHEET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COLUMN_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CELL_REF_PATTERN = /^([A-Z])([1-9][0-9]{0,2})$/;

export function isSheetId(value: unknown): value is string {
  return typeof value === "string" && SHEET_ID_PATTERN.test(value);
}

/** Column letter of a 1-based column number, "A" to "Z"; `null` outside 1..26. */
export function columnLabel(column: number): string | null {
  if (!Number.isInteger(column) || column < 1 || column > MAX_SHEET_COLUMNS) return null;
  return COLUMN_LABELS[column - 1] ?? null;
}

/** "B3" for column 2, row 3; `null` when either is outside the grid limits. */
export function formatCellRef(column: number, row: number): string | null {
  const label = columnLabel(column);
  if (label === null || !Number.isInteger(row) || row < 1 || row > MAX_SHEET_ROWS) return null;
  return `${label}${row}`;
}

/** Splits an A1 reference into 1-based column and row; `null` unless canonical A1 in the limits. */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = CELL_REF_PATTERN.exec(ref);
  if (match === null) return null;
  const row = Number(match[2]);
  if (row > MAX_SHEET_ROWS) return null;
  return { column: COLUMN_LABELS.indexOf(match[1]!) + 1, row };
}
