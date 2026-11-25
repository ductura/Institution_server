// The CSV of one sheet of a spreadsheet work (SRV-V14-SHEET-CSV, decision 6 of
// the val 14 review): UTF-8 with a byte order mark so the Croatian letters
// read right, `;` between cells (the list separator of Croatian Excel), CRLF
// line ends, the first sheet unless a sheet is named, and the computed value
// of every cell. A formula cell stores no result (decision 4): the result is
// computed here from the formulas, never read from the document. A number is
// plain decimal text with a point and at most 15 significant digits (the rule
// of the result, locale free); an error is its code (#DIV/0!). A text a
// spreadsheet would read as a formula (= + - @ or a tab or carriage return
// first) gets a leading apostrophe; it is never evaluated. A number, even a
// negative one, is not such a text and is written as it is.
import {
  computeSheet,
  formatCellRef,
  roundResult,
  parseCellRef,
  type ComputedCell,
  type Sheet,
  type SheetDocument,
  validateSheetDocument,
} from "../../domain/index.ts";

const BOM = "﻿";
const SEPARATOR = ";";
const LINE_END = "\r\n";
const FORMULA_START = /^[=+\-@\t\r]/u;
const NEEDS_QUOTES = /[;"\r\n]/u;

/** A finite number as plain decimal text: no exponent, no `-0`, shortest digits that read back. */
export function plainDecimal(value: number): string {
  if (value === 0) return "0";
  const [mantissa = "0", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  let text: string;
  if (exponent >= digits.length - 1) text = digits + "0".repeat(exponent - digits.length + 1);
  else if (exponent >= 0) text = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  else text = `0.${"0".repeat(-exponent - 1)}${digits}`;
  return value < 0 ? `-${text}` : text;
}

function escapeText(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function cellText(sheet: Sheet, ref: string, computed: Record<string, ComputedCell>): string {
  const cell = sheet.cells[ref];
  if (cell === undefined) return "";
  const result: ComputedCell | undefined =
    cell.formula === undefined
      ? typeof cell.value === "number"
        ? { type: "number", value: cell.value }
        : { type: "text", value: cell.value }
      : computed[ref];
  if (result === undefined) return "";
  if (result.type === "number") return plainDecimal(roundResult(result.value));
  if (result.type === "error") return result.code;
  return escapeText(result.value);
}

/** The rows of `sheet` up to its last filled row and column, as CSV text without the BOM. */
function sheetRows(sheet: Sheet): string {
  const computed = computeSheet(sheet);
  let lastRow = 0;
  let lastColumn = 0;
  for (const ref of Object.keys(sheet.cells)) {
    const at = parseCellRef(ref);
    if (at === null) continue;
    lastRow = Math.max(lastRow, at.row);
    lastColumn = Math.max(lastColumn, at.column);
  }
  const lines: string[] = [];
  for (let row = 1; row <= lastRow; row += 1) {
    const cells: string[] = [];
    for (let column = 1; column <= lastColumn; column += 1) {
      cells.push(cellText(sheet, formatCellRef(column, row) ?? "", computed));
    }
    lines.push(cells.join(SEPARATOR));
  }
  return lines.map((line) => line + LINE_END).join("");
}

export type SheetCsv =
  { readonly status: "ok"; readonly bytes: Uint8Array } | { readonly status: "no_sheet" };

/**
 * The CSV of a validated sheet document: the sheet with id `sheetId`, or the
 * first sheet when none is named. A sheet id the document does not have is
 * `no_sheet`. The same document gives the same bytes.
 */
export function renderSheetCsv(doc: SheetDocument, sheetId: string | null): SheetCsv {
  const sheet = sheetId === null ? doc.sheets[0] : doc.sheets.find((item) => item.id === sheetId);
  if (sheet === undefined) return { status: "no_sheet" };
  return { status: "ok", bytes: new TextEncoder().encode(BOM + sheetRows(sheet)) };
}

/**
 * The CSV of a stored text: the text must be a valid spreadsheet document
 * (`not_a_sheet` for a text work or a broken body), then as renderSheetCsv.
 */
export function renderSheetCsvOfText(
  body: string,
  sheetId: string | null,
): SheetCsv | { readonly status: "not_a_sheet" } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { status: "not_a_sheet" };
  }
  const checked = validateSheetDocument(raw);
  return checked.ok ? renderSheetCsv(checked.doc, sheetId) : { status: "not_a_sheet" };
}
