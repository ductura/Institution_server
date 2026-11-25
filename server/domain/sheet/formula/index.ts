// Public interface of server/domain/sheet/formula; other folders import only this file.
export { computeSheet, computeSheetDocument } from "./compute.ts";
export {
  FORMULA_ERROR_CODES,
  evaluateFormula,
  type ComputedCell,
  type EvaluationContext,
  type FormulaErrorCode,
  type FormulaValue,
} from "./evaluate.ts";
export {
  RESULT_SIGNIFICANT_DIGITS,
  compareText,
  parseDecimalText,
  roundResult,
  roundToDecimals,
} from "./number.ts";
export {
  FORMULA_PARSE_CODES,
  FUNCTION_NAMES,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_RANGE_CELLS,
  parseFormula,
  type BinaryOperator,
  type CellPosition,
  type FormulaNode,
  type FormulaParse,
  type FormulaParseCode,
  type FunctionName,
} from "./parse.ts";
