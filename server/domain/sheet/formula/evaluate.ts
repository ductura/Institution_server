/**
 * Evaluation of a parsed formula against the values of the cells it reads
 * (decision 3 of the val 14 review). Pure and deterministic: the same tree and
 * the same cell values give the same result. An error is a value, one of five
 * codes; the first error met in the order of evaluation is the result.
 */

import type { FormulaNode, FunctionName } from "./parse.ts";
import {
  compareText,
  normalizeZero,
  parseDecimalText,
  roundResult,
  roundToDecimals,
} from "./number.ts";

export const FORMULA_ERROR_CODES = ["#DIV/0!", "#REF!", "#CIRC!", "#NAME?", "#VALUE!"] as const;
export type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number];

/** What a formula cell shows. An empty cell is absent from the result. */
export type ComputedCell =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "error"; code: FormulaErrorCode };

/** A value while evaluating; `empty` is a cell with nothing in it. */
export type FormulaValue = ComputedCell | { type: "empty" };

/** What the evaluator may read: the size of the sheet and the value of a cell. */
export type EvaluationContext = {
  rows: number;
  columns: number;
  cell: (column: number, row: number) => FormulaValue;
};

class Fault extends Error {
  readonly code: FormulaErrorCode;
  constructor(code: FormulaErrorCode) {
    super(code);
    this.code = code;
  }
}

const ZERO: FormulaValue = { type: "number", value: 0 };

function number(value: number): FormulaValue {
  if (!Number.isFinite(value)) throw new Fault("#VALUE!");
  return { type: "number", value: normalizeZero(value) };
}

function toNumber(value: FormulaValue): number {
  switch (value.type) {
    case "number":
      return value.value;
    case "empty":
      return 0;
    case "text": {
      const parsed = parseDecimalText(value.value);
      if (parsed === null) throw new Fault("#VALUE!");
      return parsed;
    }
    case "error":
      throw new Fault(value.code);
  }
}

function compare(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
  if (left.type === "error") throw new Fault(left.code);
  if (right.type === "error") throw new Fault(right.code);
  // An empty cell is 0 beside a number and "" beside a text.
  const l =
    left.type === "empty"
      ? right.type === "text"
        ? { type: "text" as const, value: "" }
        : ZERO
      : left;
  const r =
    right.type === "empty"
      ? left.type === "text"
        ? { type: "text" as const, value: "" }
        : ZERO
      : right;
  if (l.type === "error" || r.type === "error") throw new Fault("#VALUE!");
  let order: number;
  if (l.type === "number" && r.type === "number") {
    order = l.value === r.value ? 0 : l.value < r.value ? -1 : 1;
  } else if (l.type === "text" && r.type === "text") {
    order = compareText(l.value, r.value);
  } else if (operator === "=" || operator === "<>") {
    // A number never equals a text.
    return number(operator === "<>" ? 1 : 0);
  } else {
    throw new Fault("#VALUE!");
  }
  const truth =
    operator === "="
      ? order === 0
      : operator === "<>"
        ? order !== 0
        : operator === "<"
          ? order < 0
          : operator === "<="
            ? order <= 0
            : operator === ">"
              ? order > 0
              : order >= 0;
  return number(truth ? 1 : 0);
}

class Evaluator {
  private readonly context: EvaluationContext;

  constructor(context: EvaluationContext) {
    this.context = context;
  }

  private inSheet(column: number, row: number): boolean {
    return column <= this.context.columns && row <= this.context.rows;
  }

  value(node: FormulaNode): FormulaValue {
    switch (node.type) {
      case "number":
        return { type: "number", value: node.value };
      case "text":
        return { type: "text", value: node.value };
      case "ref":
        if (!this.inSheet(node.at.column, node.at.row)) throw new Fault("#REF!");
        return this.context.cell(node.at.column, node.at.row);
      case "range":
        // A range is only an argument of a function, never a single value.
        throw new Fault("#VALUE!");
      case "bad-ref":
        throw new Fault("#REF!");
      case "bad-name":
        throw new Fault("#NAME?");
      case "unary": {
        const operand = toNumber(this.value(node.operand));
        return number(node.operator === "-" ? -operand : operand);
      }
      case "binary": {
        const left = this.value(node.left);
        // The first error wins: a left error is not hidden by one on the right.
        if (left.type === "error") throw new Fault(left.code);
        const right = this.value(node.right);
        if (
          node.operator === "=" ||
          node.operator === "<>" ||
          node.operator === "<" ||
          node.operator === "<=" ||
          node.operator === ">" ||
          node.operator === ">="
        ) {
          return compare(node.operator, left, right);
        }
        const a = toNumber(left);
        const b = toNumber(right);
        if (node.operator === "+") return number(a + b);
        if (node.operator === "-") return number(a - b);
        if (node.operator === "*") return number(a * b);
        if (b === 0) throw new Fault("#DIV/0!");
        return number(a / b);
      }
      case "call":
        return this.call(node.name, node.args);
    }
  }

  private call(name: FunctionName, args: FormulaNode[]): FormulaValue {
    switch (name) {
      case "IF":
        return this.conditional(args);
      case "ABS":
        if (args.length !== 1) throw new Fault("#VALUE!");
        return number(Math.abs(toNumber(this.value(args[0]!))));
      case "ROUND": {
        if (args.length !== 2) throw new Fault("#VALUE!");
        const value = toNumber(this.value(args[0]!));
        const decimals = Math.trunc(toNumber(this.value(args[1]!)));
        return number(roundToDecimals(value, decimals));
      }
      case "COUNT":
        return number(this.numbers(args, true).length);
      case "SUM":
        return number(sumOf(this.numbers(args, false)));
      case "AVERAGE": {
        const numbers = this.numbers(args, false);
        if (numbers.length === 0) throw new Fault("#DIV/0!");
        return number(sumOf(numbers) / numbers.length);
      }
      case "MIN": {
        const numbers = this.numbers(args, false);
        return number(numbers.length === 0 ? 0 : Math.min(...numbers));
      }
      case "MAX": {
        const numbers = this.numbers(args, false);
        return number(numbers.length === 0 ? 0 : Math.max(...numbers));
      }
    }
  }

  // Only the chosen branch is evaluated, so an error in the other one is not seen.
  private conditional(args: FormulaNode[]): FormulaValue {
    if (args.length !== 2 && args.length !== 3) throw new Fault("#VALUE!");
    const condition = this.value(args[0]!);
    if (condition.type === "text") throw new Fault("#VALUE!");
    const truth = condition.type === "number" && condition.value !== 0;
    if (condition.type === "error") throw new Fault(condition.code);
    const branch = truth ? args[1] : args[2];
    return branch === undefined ? ZERO : this.value(branch);
  }

  // Numbers of the arguments. References and ranges give their numbers only
  // (text and empty cells are skipped); an error cell is the result unless the
  // caller counts. A direct argument must be a number or a number as text.
  private numbers(args: FormulaNode[], counting: boolean): number[] {
    const numbers: number[] = [];
    if (args.length === 0) throw new Fault("#VALUE!");
    const take = (value: FormulaValue): void => {
      if (value.type === "number") numbers.push(value.value);
      else if (value.type === "error" && !counting) throw new Fault(value.code);
    };
    for (const arg of args) {
      if (arg.type === "range") {
        if (!this.inSheet(arg.to.column, arg.to.row)) throw new Fault("#REF!");
        for (let row = arg.from.row; row <= arg.to.row; row += 1) {
          for (let column = arg.from.column; column <= arg.to.column; column += 1) {
            take(this.context.cell(column, row));
          }
        }
      } else if (arg.type === "ref") {
        take(this.value(arg));
      } else if (arg.type === "bad-ref" || arg.type === "bad-name") {
        this.value(arg);
      } else if (counting) {
        try {
          const value = this.value(arg);
          const asNumber = value.type === "text" ? parseDecimalText(value.value) : null;
          if (value.type === "number") numbers.push(value.value);
          else if (asNumber !== null) numbers.push(asNumber);
        } catch (failure) {
          if (!(failure instanceof Fault)) throw failure;
        }
      } else {
        numbers.push(toNumber(this.value(arg)));
      }
    }
    return numbers;
  }
}

// Ascending order makes the sum the same for the same numbers in any order,
// so moving rows around never changes a total.
function sumOf(numbers: number[]): number {
  return [...numbers].sort((a, b) => a - b).reduce((total, value) => total + value, 0);
}

/** Result of one formula, rounded to 15 significant digits; an empty result is 0. */
export function evaluateFormula(node: FormulaNode, context: EvaluationContext): ComputedCell {
  try {
    const value = new Evaluator(context).value(node);
    if (value.type === "empty") return { type: "number", value: 0 };
    if (value.type === "number") return { type: "number", value: roundResult(value.value) };
    return value;
  } catch (failure) {
    if (failure instanceof Fault) return { type: "error", code: failure.code };
    throw failure;
  }
}
