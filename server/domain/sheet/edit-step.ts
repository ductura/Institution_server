// SRV-V14-SHEET-EVIDENCE (val 14, decision 4): the serialised editing step of a
// spreadsheet document, format `ductus-sheet-steps-v1`: its application and
// revision 0. Pure: no clock, no I/O. A step records a change of a cell, a row,
// a column or a sheet name, never a key press. The step type and its reader
// are in ./model/ (no Node module, SRV-V14-PARSERI-BEZ-NODE); the hashes a step
// carries are in ./step-hash.ts.
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
import { canonicalizeJcs } from "../forensics/index.ts";

import {
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SHEET_SNAPSHOT_BYTES,
  SHEET_KIND,
  SHEET_SCHEMA_VERSION,
  columnLabel,
  formatCellRef,
  parseCellRef,
  type Sheet,
  type SheetCell,
  type SheetDocument,
  type SheetStep,
} from "./model/index.ts";
import { sheetCellSha256, sheetCellsSha256, sheetTextSha256 } from "./step-hash.ts";
import { validateSheetDocument } from "./validate.ts";

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
      if (old !== undefined && old.formula === cell.formula && Object.is(old.value, cell.value)) {
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
