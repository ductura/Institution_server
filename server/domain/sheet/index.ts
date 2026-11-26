// Public interface of server/domain/sheet; other folders import only this file.
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
} from "./model/index.ts";
export {
  SHEET_VALIDATION_CODES,
  filledCellCount,
  sheetDigest,
  sheetDocumentsEqual,
  sheetJcsBytes,
  validateSheetDocument,
  type SheetValidation,
  type SheetValidationCode,
  type SheetValidationError,
} from "./validate.ts";
// The formula computer, so that the domain index re-exports one file (SRV-V14-SHEET-CSV).
export { computeSheet, roundResult, type ComputedCell } from "./formula/index.ts";
// The editing steps and their application (SRV-V14-SHEET-EVIDENCE). The step
// reader is in ./model/, with no Node module (SRV-V14-PARSERI-BEZ-NODE).
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
  type SheetStepsParse,
  type SheetStepType,
} from "./model/index.ts";
export { sheetCellSha256, sheetCellsSha256, sheetTextSha256 } from "./step-hash.ts";
export {
  SHEET_REVISION_ZERO_SHEET_ID,
  applySheetStep,
  applySheetSteps,
  sheetRevisionZeroDocument,
  type ApplySheetStep,
  type ApplySheetStepErrorCode,
  type ApplySheetSteps,
} from "./edit-step.ts";
