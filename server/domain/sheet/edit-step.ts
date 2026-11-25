// SRV-V14-SHEET-EVIDENCE (val 14, decision 4): the serialised editing step of a
// spreadsheet document, format `ductus-sheet-steps-v1`, and its application.
// Pure: no clock, no I/O. A step records a change of a cell, a row, a column or
// a sheet name, never a key press.
//
// Rules, as for the text and slide steps:
//   - every object has a closed set of keys: an unknown field, `__proto__` and
//     any time field have nowhere to sit;
//   - an unknown step type is refused (`unknown_step`), never skipped;
//   - a step that replaces or removes content carries the SHA-256 of what it
//     replaces or removes, so nothing is deleted or overwritten silently;
//   - the result of every step is checked by `validateSheetDocument`, so every
//     limit of the model holds after every step;
//   - application is atomic: the input is never changed, a refused step leaves
//     no trace, nothing is repaired.
//
// Assumption (recorded in the PR): inserting or removing a row or a column
// moves the cells only; the text of a formula is NOT rewritten. The editor
// states any formula change it wants as its own `cellSet` step, so the log
// holds every change of every formula.
import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../forensics/index.ts";
import { hasOnlyKeys, isPlainObject, ownProperty } from "../json/index.ts";

import {
  MAX_FORMULA_CODE_POINTS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  SHEET_KIND,
  SHEET_SCHEMA_VERSION,
  columnLabel,
  formatCellRef,
  isSheetId,
  parseCellRef,
  type Sheet,
  type SheetCell,
  type SheetDocument,
} from "./schema.ts";
import { validateSheetDocument } from "./validate.ts";

/** Value of `captureContext.transactionFormat` for spreadsheet documents. */
export const SHEET_STEP_FORMAT_V1 = "ductus-sheet-steps-v1" as const;

export const SHEET_STEP_TYPES = [
  "cellSet",
  "cellClear",
  "rowInsert",
  "rowRemove",
  "columnInsert",
  "columnRemove",
  "sheetRename",
] as const;
export type SheetStepType = (typeof SHEET_STEP_TYPES)[number];

/** Most steps in the array of one event (as for slides). */
export const MAX_SHEET_STEPS_PER_EVENT = 1000;
/** Most UTF-8 bytes of the array of one event, as for a whole segment (2 MiB). */
export const MAX_SHEET_STEPS_BYTES = 2_097_152;
/** Most UTF-8 bytes of a snapshot of a spreadsheet document (2 MiB). */
export const MAX_SHEET_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * Puts text, a number or a formula in a cell. `replacedSha256` is the SHA-256
 * of the JCS text of the cell it replaces and is present exactly when the cell
 * was filled. A step that changes nothing is refused (`no_change`).
 */
export type CellSetStep = {
  type: "cellSet";
  sheetId: string;
  ref: string;
  value?: string | number;
  formula?: string;
  replacedSha256?: string;
};
/** Empties a filled cell; `removedSha256` is the SHA-256 of its JCS text. */
export type CellClearStep = {
  type: "cellClear";
  sheetId: string;
  ref: string;
  removedSha256: string;
};
/** Inserts an empty row so that it is row `row` afterwards (1 to rows + 1). */
export type RowInsertStep = { type: "rowInsert"; sheetId: string; row: number };
/**
 * Removes row `row`; `removedSha256` is the SHA-256 of the JCS text of the
 * cells of that row, an object keyed by A1 reference (`{}` for an empty row).
 */
export type RowRemoveStep = {
  type: "rowRemove";
  sheetId: string;
  row: number;
  removedSha256: string;
};
/** Inserts an empty column so that it is column `column` afterwards (1 to columns + 1). */
export type ColumnInsertStep = { type: "columnInsert"; sheetId: string; column: number };
/** Removes column `column`; `removedSha256` as for a row. */
export type ColumnRemoveStep = {
  type: "columnRemove";
  sheetId: string;
  column: number;
  removedSha256: string;
};
/** Renames a sheet; `replacedSha256` is the SHA-256 of the UTF-8 bytes of the old name. */
export type SheetRenameStep = {
  type: "sheetRename";
  sheetId: string;
  name: string;
  replacedSha256: string;
};

export type SheetStep =
  | CellSetStep
  | CellClearStep
  | RowInsertStep
  | RowRemoveStep
  | ColumnInsertStep
  | ColumnRemoveStep
  | SheetRenameStep;

export type SheetStepErrorCode =
  "not_an_object" | "unknown_step" | "step_invalid" | "too_many_steps" | "too_large";
export type SheetStepParse =
  { ok: true; step: SheetStep } | { ok: false; error: SheetStepErrorCode };
export type SheetStepsParse =
  { ok: true; steps: SheetStep[] } | { ok: false; error: SheetStepErrorCode; index?: number };

const KEYS: Readonly<Record<SheetStepType, ReadonlySet<string>>> = {
  cellSet: new Set(["type", "sheetId", "ref", "value", "formula", "replacedSha256"]),
  cellClear: new Set(["type", "sheetId", "ref", "removedSha256"]),
  rowInsert: new Set(["type", "sheetId", "row"]),
  rowRemove: new Set(["type", "sheetId", "row", "removedSha256"]),
  columnInsert: new Set(["type", "sheetId", "column"]),
  columnRemove: new Set(["type", "sheetId", "column", "removedSha256"]),
  sheetRename: new Set(["type", "sheetId", "name", "replacedSha256"]),
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** SHA-256 (lowercase hex) of the UTF-8 bytes of a text; the `replacedSha256` of a sheet name. */
export function sheetTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of the JCS text of a cell: the `replacedSha256` and `removedSha256` of a cell step. */
export function sheetCellSha256(cell: SheetCell): string {
  return sheetTextSha256(canonicalizeJcs(cell));
}

/** SHA-256 of the JCS text of a map of cells: the `removedSha256` of a row or column removal. */
export function sheetCellsSha256(cells: Record<string, SheetCell>): string {
  return sheetTextSha256(canonicalizeJcs(cells));
}

/**
 * Reads one step. An accepted step is a fresh copy with only known fields;
 * everything else is refused, never guessed. Limits that depend on the
 * document (is the cell inside the sheet, does the hash match) are
 * `applySheetStep`'s checks; the shape of values is the document validator's,
 * run on the result.
 */
export function parseSheetStep(raw: unknown): SheetStepParse {
  if (!isPlainObject(raw)) return { ok: false, error: "not_an_object" };
  const type = ownProperty(raw, "type");
  if (typeof type !== "string" || !(SHEET_STEP_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "unknown_step" };
  }
  const kind = type as SheetStepType;
  const bad = { ok: false, error: "step_invalid" } as const;
  if (!hasOnlyKeys(raw, KEYS[kind])) return bad;
  const sheetId = ownProperty(raw, "sheetId");
  if (!isSheetId(sheetId)) return bad;
  const get = (key: string): unknown => ownProperty(raw, key);

  switch (kind) {
    case "cellSet": {
      const ref = get("ref");
      if (typeof ref !== "string" || parseCellRef(ref) === null) return bad;
      const hasValue = Object.hasOwn(raw, "value");
      const hasFormula = Object.hasOwn(raw, "formula");
      // Exactly one of the two: a formula cell stores no value, a value cell no formula.
      if (hasValue === hasFormula) return bad;
      const value = get("value");
      const formula = get("formula");
      if (hasValue) {
        if (typeof value === "number") {
          if (!Number.isFinite(value)) return bad;
        } else if (typeof value !== "string") return bad;
      } else if (
        typeof formula !== "string" ||
        Array.from(formula).length > MAX_FORMULA_CODE_POINTS
      ) {
        return bad;
      }
      const hasHash = Object.hasOwn(raw, "replacedSha256");
      const replacedSha256 = get("replacedSha256");
      if (hasHash && !isSha256(replacedSha256)) return bad;
      return {
        ok: true,
        step: {
          type: kind,
          sheetId,
          ref,
          ...(hasValue ? { value: value as string | number } : { formula: formula as string }),
          ...(hasHash ? { replacedSha256: replacedSha256 as string } : {}),
        },
      };
    }
    case "cellClear": {
      const ref = get("ref");
      const removedSha256 = get("removedSha256");
      if (typeof ref !== "string" || parseCellRef(ref) === null || !isSha256(removedSha256)) {
        return bad;
      }
      return { ok: true, step: { type: kind, sheetId, ref, removedSha256 } };
    }
    case "rowInsert": {
      const row = get("row");
      if (!isPosition(row)) return bad;
      return { ok: true, step: { type: kind, sheetId, row } };
    }
    case "rowRemove": {
      const row = get("row");
      const removedSha256 = get("removedSha256");
      if (!isPosition(row) || !isSha256(removedSha256)) return bad;
      return { ok: true, step: { type: kind, sheetId, row, removedSha256 } };
    }
    case "columnInsert": {
      const column = get("column");
      if (!isPosition(column)) return bad;
      return { ok: true, step: { type: kind, sheetId, column } };
    }
    case "columnRemove": {
      const column = get("column");
      const removedSha256 = get("removedSha256");
      if (!isPosition(column) || !isSha256(removedSha256)) return bad;
      return { ok: true, step: { type: kind, sheetId, column, removedSha256 } };
    }
    case "sheetRename": {
      const name = get("name");
      const replacedSha256 = get("replacedSha256");
      if (typeof name !== "string" || !isSha256(replacedSha256)) return bad;
      return { ok: true, step: { type: kind, sheetId, name, replacedSha256 } };
    }
  }
}

/**
 * Reads the array of one event: 1 to `MAX_SHEET_STEPS_PER_EVENT` steps, at
 * most `MAX_SHEET_STEPS_BYTES` of UTF-8. One bad step refuses the whole array.
 */
export function parseSheetSteps(raw: unknown): SheetStepsParse {
  if (!Array.isArray(raw)) return { ok: false, error: "step_invalid" };
  if (raw.length < 1) return { ok: false, error: "step_invalid" };
  if (raw.length > MAX_SHEET_STEPS_PER_EVENT) return { ok: false, error: "too_many_steps" };
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return { ok: false, error: "step_invalid", index };
  }
  const steps: SheetStep[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseSheetStep(raw[index]);
    if (!parsed.ok) return { ok: false, error: parsed.error, index };
    steps.push(parsed.step);
  }
  // The steps are fresh known-keys copies of valid input, so the JCS form cannot throw.
  if (Buffer.byteLength(canonicalizeJcs(steps), "utf8") > MAX_SHEET_STEPS_BYTES) {
    return { ok: false, error: "too_large" };
  }
  return { ok: true, steps };
}

/**
 * Revision 0 of every spreadsheet work: one empty sheet "List1" of 100 rows and
 * 10 columns. The id is fixed, not random, so every new spreadsheet work starts
 * from the same bytes and hash. Changing any value is a question for the owner.
 */
export const SHEET_REVISION_ZERO_SHEET_ID = "00000000-0000-4000-8000-000000000000";

export function sheetRevisionZeroDocument(): SheetDocument {
  return {
    schemaVersion: SHEET_SCHEMA_VERSION,
    kind: SHEET_KIND,
    sheets: [
      { id: SHEET_REVISION_ZERO_SHEET_ID, name: "List1", rows: 100, columns: 10, cells: {} },
    ],
  };
}

export type ApplySheetStepErrorCode =
  | "document_invalid"
  | "sheet_not_found"
  | "cell_out_of_grid"
  | "index_out_of_range"
  | "hash_mismatch"
  | "no_change"
  | "result_invalid"
  | "too_large";

export type ApplySheetStep =
  { ok: true; doc: SheetDocument } | { ok: false; error: ApplySheetStepErrorCode };
export type ApplySheetSteps =
  { ok: true; doc: SheetDocument } | { ok: false; error: ApplySheetStepErrorCode; index: number };

type Fail = { error: ApplySheetStepErrorCode };

function fail(error: ApplySheetStepErrorCode): Fail {
  return { error };
}

/** The cells of one row or column of a sheet, keyed by A1 reference (the removed content). */
function lineCells(sheet: Sheet, axis: "row" | "column", position: number) {
  const out: Record<string, SheetCell> = {};
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const at = parseCellRef(ref)!;
    if ((axis === "row" ? at.row : at.column) === position) out[ref] = cell;
  }
  return out;
}

/** Moves every cell at or after `position` on the axis by `delta`, dropping those on `position` when removing. */
function shiftCells(sheet: Sheet, axis: "row" | "column", position: number, delta: 1 | -1): void {
  const next: Record<string, SheetCell> = {};
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const at = parseCellRef(ref)!;
    const coordinate = axis === "row" ? at.row : at.column;
    if (delta === -1 && coordinate === position) continue;
    const moved = coordinate >= position ? coordinate + delta : coordinate;
    const target = axis === "row" ? formatCellRef(at.column, moved) : formatCellRef(moved, at.row);
    // A cell pushed off the grid cannot happen: the grid grows with an insert.
    if (target !== null) next[target] = cell;
  }
  sheet.cells = next;
}

/** Applies one step to a draft (a deep copy that the caller owns). */
function mutate(doc: SheetDocument, step: SheetStep): Fail | null {
  const sheet = doc.sheets.find((candidate) => candidate.id === step.sheetId);
  if (sheet === undefined) return fail("sheet_not_found");

  switch (step.type) {
    case "cellSet": {
      const at = parseCellRef(step.ref)!;
      if (at.row > sheet.rows || at.column > sheet.columns) return fail("cell_out_of_grid");
      const old = Object.hasOwn(sheet.cells, step.ref) ? sheet.cells[step.ref]! : undefined;
      // The hash of the replaced cell is present exactly when there was one.
      if ((old !== undefined) !== (step.replacedSha256 !== undefined)) return fail("hash_mismatch");
      if (old !== undefined && sheetCellSha256(old) !== step.replacedSha256) {
        return fail("hash_mismatch");
      }
      const cell: SheetCell =
        step.formula !== undefined
          ? { value: null, formula: step.formula }
          : { value: step.value as string | number };
      if (old !== undefined && canonicalizeJcs(old) === canonicalizeJcs(cell)) {
        return fail("no_change");
      }
      sheet.cells[step.ref] = cell;
      return null;
    }
    case "cellClear": {
      const at = parseCellRef(step.ref)!;
      if (at.row > sheet.rows || at.column > sheet.columns) return fail("cell_out_of_grid");
      const old = Object.hasOwn(sheet.cells, step.ref) ? sheet.cells[step.ref]! : undefined;
      if (old === undefined) return fail("no_change");
      if (sheetCellSha256(old) !== step.removedSha256) return fail("hash_mismatch");
      delete sheet.cells[step.ref];
      return null;
    }
    case "rowInsert": {
      if (step.row > sheet.rows + 1 || sheet.rows + 1 > MAX_SHEET_ROWS) {
        return fail("index_out_of_range");
      }
      shiftCells(sheet, "row", step.row, 1);
      sheet.rows += 1;
      return null;
    }
    case "rowRemove": {
      if (step.row > sheet.rows) return fail("index_out_of_range");
      if (sheetCellsSha256(lineCells(sheet, "row", step.row)) !== step.removedSha256) {
        return fail("hash_mismatch");
      }
      shiftCells(sheet, "row", step.row, -1);
      sheet.rows -= 1;
      return null;
    }
    case "columnInsert": {
      if (step.column > sheet.columns + 1 || sheet.columns + 1 > MAX_SHEET_COLUMNS) {
        return fail("index_out_of_range");
      }
      shiftCells(sheet, "column", step.column, 1);
      sheet.columns += 1;
      return null;
    }
    case "columnRemove": {
      if (step.column > sheet.columns || columnLabel(step.column) === null) {
        return fail("index_out_of_range");
      }
      if (sheetCellsSha256(lineCells(sheet, "column", step.column)) !== step.removedSha256) {
        return fail("hash_mismatch");
      }
      shiftCells(sheet, "column", step.column, -1);
      sheet.columns -= 1;
      return null;
    }
    case "sheetRename": {
      if (sheetTextSha256(sheet.name) !== step.replacedSha256) return fail("hash_mismatch");
      if (sheet.name === step.name) return fail("no_change");
      sheet.name = step.name;
      return null;
    }
  }
}

/**
 * Applies one step. The input document is never changed. The result is always
 * a document `validateSheetDocument` accepts, and within the snapshot limit.
 */
export function applySheetStep(doc: SheetDocument, step: SheetStep): ApplySheetStep {
  const valid = validateSheetDocument(doc);
  if (!valid.ok) return { ok: false, error: "document_invalid" };
  const draft = structuredClone(valid.doc);
  const refused = mutate(draft, step);
  if (refused !== null) return { ok: false, error: refused.error };
  const checked = validateSheetDocument(draft);
  if (!checked.ok) return { ok: false, error: "result_invalid" };
  if (Buffer.byteLength(canonicalizeJcs(checked.doc), "utf8") > MAX_SHEET_SNAPSHOT_BYTES) {
    return { ok: false, error: "too_large" };
  }
  return { ok: true, doc: checked.doc };
}

/** Applies the steps of one event in order; the first refused step refuses all, with its index. */
export function applySheetSteps(doc: SheetDocument, steps: readonly SheetStep[]): ApplySheetSteps {
  let current = doc;
  for (let index = 0; index < steps.length; index += 1) {
    const applied = applySheetStep(current, steps[index]!);
    if (!applied.ok) return { ok: false, error: applied.error, index };
    current = applied.doc;
  }
  return { ok: true, doc: current };
}
