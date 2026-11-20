/**
 * The table of document v4 (docs/contracts/document-schema-v4.md §5.1), for
 * `validateDocumentV4`, and the field rules the image and the cover share.
 * The caller checks the block's keys and id; these check the fields. Nothing
 * is repaired, and a valid value is copied from known fields only.
 */

import { isPlainObject } from "../json/index.ts";
import { isAllowedText, isAllowedTrimmedText } from "./forbidden.ts";
import {
  MAX_FIGURE_TEXT_CODE_POINTS,
  MAX_TABLE_CELLS,
  MAX_TABLE_CELL_CODE_POINTS,
  type NodeId,
  type TableCellFill,
  type TableMerge,
  type TableNode,
} from "./schema.ts";
import { checkUnknownFields } from "./validate-sources.ts";
import type { ValidationError, ValidationErrorCode } from "./validate.ts";

export type Raw = Record<string, unknown>;

export const TABLE_FIELDS = new Set([
  "type",
  "id",
  "rows",
  "header",
  "stripes",
  "landscape",
  "headerFill",
  "cellFills",
  "merges",
  "title",
  "source",
]);
const COLOR = /^#[0-9a-f]{6}$/;

/** A JSON integer: safe, and never -0 (contract §1). */
export function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= min &&
    value <= max
  );
}

export function flag(raw: Raw, key: string, path: string, errors: ValidationError[]): boolean {
  if (typeof raw[key] !== "boolean") {
    errors.push({ path: `${path}.${key}`, code: "BLOCK_FLAG_INVALID" });
    return false;
  }
  return raw[key];
}

/** Optional tidy text: absent is `{}`, invalid is an error and `{}`. */
export function tidy(
  raw: Raw,
  key: string,
  path: string,
  max: number,
  code: ValidationErrorCode,
  errors: ValidationError[],
): Record<string, string> {
  if (!Object.hasOwn(raw, key)) return {};
  if (!isAllowedTrimmedText(raw[key], max)) {
    errors.push({ path: `${path}.${key}`, code });
    return {};
  }
  return { [key]: raw[key] };
}

export function figureTexts(
  raw: Raw,
  path: string,
  errors: ValidationError[],
): Record<string, string> {
  return {
    ...tidy(raw, "title", path, MAX_FIGURE_TEXT_CODE_POINTS, "FIGURE_TITLE_INVALID", errors),
    ...tidy(raw, "source", path, MAX_FIGURE_TEXT_CODE_POINTS, "FIGURE_SOURCE_INVALID", errors),
  };
}

/** §5.1. Merges and fills are checked against the rows only when those are valid. */
export function validateTable(
  raw: Raw,
  path: string,
  id: NodeId | null,
  errors: ValidationError[],
): TableNode | null {
  const before = errors.length;
  const rows = validateRows(raw.rows, `${path}.rows`, errors);
  const header = flag(raw, "header", path, errors);
  const stripes = flag(raw, "stripes", path, errors);
  const landscape = flag(raw, "landscape", path, errors);
  const texts = figureTexts(raw, path, errors);
  if (Object.hasOwn(raw, "headerFill") && !(header && isColor(raw.headerFill))) {
    errors.push({ path: `${path}.headerFill`, code: "TABLE_FILL_INVALID" });
  }
  let merges: TableMerge[] | undefined;
  let cellFills: TableCellFill[] | undefined;
  if (rows !== null) {
    const covered = new Set<string>();
    merges = Object.hasOwn(raw, "merges")
      ? validateMerges(raw.merges, `${path}.merges`, rows, covered, errors)
      : undefined;
    cellFills = Object.hasOwn(raw, "cellFills")
      ? validateCellFills(raw.cellFills, `${path}.cellFills`, rows, covered, errors)
      : undefined;
  }
  if (id === null || rows === null || errors.length > before) return null;
  return {
    type: "table",
    id,
    rows,
    header,
    stripes,
    landscape,
    ...(Object.hasOwn(raw, "headerFill") ? { headerFill: raw.headerFill as string } : {}),
    ...(cellFills ? { cellFills } : {}),
    ...(merges ? { merges } : {}),
    ...texts,
  };
}

export function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR.test(value);
}

function validateRows(value: unknown, path: string, errors: ValidationError[]): string[][] | null {
  const width = Array.isArray(value) && Array.isArray(value[0]) ? value[0].length : 0;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    width === 0 ||
    value.length * width > MAX_TABLE_CELLS ||
    !Array.from(value).every((row: unknown) => Array.isArray(row) && row.length === width)
  ) {
    errors.push({ path, code: "TABLE_ROWS_INVALID" });
    return null;
  }
  let ok = true;
  const rows = (value as unknown[][]).map((row, r) =>
    Array.from(row).map((cell: unknown, c) => {
      if (cell !== "" && !isAllowedText(cell, MAX_TABLE_CELL_CODE_POINTS)) {
        errors.push({ path: `${path}[${r}][${c}]`, code: "TABLE_CELL_INVALID" });
        ok = false;
      }
      return cell as string;
    }),
  );
  return ok ? rows : null;
}

/** A non-empty array of closed objects, in strictly ascending (row, column). */
function cellList(
  value: unknown,
  path: string,
  keys: readonly string[],
  code: ValidationErrorCode,
  errors: ValidationError[],
): Raw[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, code });
    return null;
  }
  const items = Array.from(value);
  let ok = true;
  items.forEach((item: unknown, i) => {
    if (!isPlainObject(item) || !keys.every((key) => Object.hasOwn(item, key))) {
      errors.push({ path: `${path}[${i}]`, code });
      ok = false;
      return;
    }
    checkUnknownFields(item, new Set(keys), `${path}[${i}]`, errors);
    const previous = items[i - 1] as Raw | undefined;
    if (
      previous &&
      isPlainObject(previous) &&
      ((previous.row as number) > (item.row as number) ||
        (previous.row === item.row && (previous.column as number) >= (item.column as number)))
    ) {
      errors.push({ path: `${path}[${i}]`, code });
      ok = false;
    }
  });
  return ok ? (items as Raw[]) : null;
}

function validateMerges(
  value: unknown,
  path: string,
  rows: string[][],
  covered: Set<string>,
  errors: ValidationError[],
): TableMerge[] | undefined {
  const keys = ["column", "columnSpan", "row", "rowSpan"];
  const items = cellList(value, path, keys, "TABLE_MERGE_INVALID", errors);
  if (!items) return undefined;
  const height = rows.length;
  const width = rows[0]!.length;
  const taken = new Set<string>();
  const merges: TableMerge[] = [];
  items.forEach((item, i) => {
    const { row, column, rowSpan, columnSpan } = item;
    const merge =
      isInteger(row, 0, height - 1) &&
      isInteger(column, 0, width - 1) &&
      isInteger(rowSpan, 1, height - row) &&
      isInteger(columnSpan, 1, width - column) &&
      rowSpan * columnSpan > 1
        ? { column, columnSpan, row, rowSpan }
        : null;
    if (!merge || !claim(merge, rows, taken, covered)) {
      errors.push({ path: `${path}[${i}]`, code: "TABLE_MERGE_INVALID" });
      return;
    }
    merges.push(merge);
  });
  return merges.length === items.length ? merges : undefined;
}

/**
 * Marks the cells of `merge` as taken and, but for its top left cell, as
 * covered. False when a cell is already taken or a covered cell has text.
 */
function claim(
  merge: TableMerge,
  rows: string[][],
  taken: Set<string>,
  covered: Set<string>,
): boolean {
  let ok = true;
  for (let r = merge.row; r < merge.row + merge.rowSpan; r += 1) {
    for (let c = merge.column; c < merge.column + merge.columnSpan; c += 1) {
      const anchor = r === merge.row && c === merge.column;
      if (taken.has(`${r},${c}`) || (!anchor && rows[r]![c] !== "")) ok = false;
      taken.add(`${r},${c}`);
      if (!anchor) covered.add(`${r},${c}`);
    }
  }
  return ok;
}

function validateCellFills(
  value: unknown,
  path: string,
  rows: string[][],
  covered: ReadonlySet<string>,
  errors: ValidationError[],
): TableCellFill[] | undefined {
  const items = cellList(value, path, ["color", "column", "row"], "TABLE_FILL_INVALID", errors);
  if (!items) return undefined;
  const fills: TableCellFill[] = [];
  items.forEach((item, i) => {
    const { row, column, color } = item;
    if (
      !isInteger(row, 0, rows.length - 1) ||
      !isInteger(column, 0, rows[0]!.length - 1) ||
      !isColor(color) ||
      covered.has(`${row},${column}`)
    ) {
      errors.push({ path: `${path}[${i}]`, code: "TABLE_FILL_INVALID" });
      return;
    }
    fills.push({ color, column, row });
  });
  return fills.length === items.length ? fills : undefined;
}
