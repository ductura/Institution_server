// Public interface of server/domain/sheet/model: the spreadsheet document type
// and the step reader, with no Node module (SRV-V14-PARSERI-BEZ-NODE). The
// evidence segment check imports this file, so the browser bundle can hold it
// (granica 8, #638); ../index.ts re-exports everything here unchanged.
export {
  MAX_CELL_TEXT_CODE_POINTS,
  MAX_FORMULA_CODE_POINTS,
  MAX_SHEETS,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_NAME_CODE_POINTS,
  MAX_SHEET_ROWS,
  SHEET_KIND,
  SHEET_SCHEMA_VERSION,
  columnLabel,
  formatCellRef,
  isSheetId,
  parseCellRef,
  type Sheet,
  type SheetCell,
  type SheetCells,
  type SheetDocument,
} from "./schema.ts";
export {
  MAX_SHEET_SNAPSHOT_BYTES,
  MAX_SHEET_STEPS_BYTES,
  MAX_SHEET_STEPS_PER_EVENT,
  SHEET_STEP_FORMAT_V1,
  SHEET_STEP_TYPES,
  parseSheetStep,
  parseSheetSteps,
  type SheetStep,
  type SheetStepErrorCode,
  type SheetStepParse,
  type SheetStepType,
  type SheetStepsParse,
} from "./steps.ts";
