/**
 * Parser of the formula text: `=` and an expression (decision 3 of the val 14
 * review). Operators `+ - * /`, comparisons `= <> < <= > >=`, numbers, texts
 * in double quotes (`""` is one quote), A1 references and ranges, and the
 * functions SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ABS and IF. Names and
 * references are read in any letter case and kept in upper case. Nothing is
 * repaired: text that is not a formula is a failure with a code, never a guess.
 */

import { MAX_FORMULA_CODE_POINTS, parseCellRef } from "../index.ts";

/** Nesting of brackets, calls and signs (`=-(-(-1))` is three). */
export const MAX_FORMULA_DEPTH = 32;
/** Cells named by all ranges of one formula together; the grid itself holds 5200. */
export const MAX_FORMULA_RANGE_CELLS = 10_000;

export const FUNCTION_NAMES = [
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "ROUND",
  "ABS",
  "IF",
] as const;
export type FunctionName = (typeof FUNCTION_NAMES)[number];
export type BinaryOperator = "+" | "-" | "*" | "/" | "=" | "<>" | "<" | "<=" | ">" | ">=";

export type CellPosition = { column: number; row: number };

export type FormulaNode =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "ref"; at: CellPosition }
  | { type: "range"; from: CellPosition; to: CellPosition }
  /** A reference outside the grid (AA1, A0, A201): evaluates to #REF!. */
  | { type: "bad-ref" }
  /** An unknown function or a bare name: evaluates to #NAME?. */
  | { type: "bad-name" }
  | { type: "unary"; operator: "+" | "-"; operand: FormulaNode }
  | { type: "binary"; operator: BinaryOperator; left: FormulaNode; right: FormulaNode }
  | { type: "call"; name: FunctionName; args: FormulaNode[] };

export const FORMULA_PARSE_CODES = [
  "FORMULA_PREFIX",
  "FORMULA_TOO_LONG",
  "FORMULA_SYNTAX",
  "FORMULA_TOO_DEEP",
  "FORMULA_RANGE_TOO_LARGE",
] as const;
export type FormulaParseCode = (typeof FORMULA_PARSE_CODES)[number];
export type FormulaParse = { ok: true; node: FormulaNode } | { ok: false; code: FormulaParseCode };

type Token =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "name"; value: string }
  | { kind: "symbol"; value: string };

class ParseFailure extends Error {
  readonly code: FormulaParseCode;
  constructor(code: FormulaParseCode) {
    super(code);
    this.code = code;
  }
}

const NUMBER_AT = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/;
const NAME_AT = /^[A-Za-z][A-Za-z0-9_]*/;
const REF_LIKE = /^[A-Z]+[0-9]+$/;
const SYMBOLS = ["<>", "<=", ">=", "+", "-", "*", "/", "=", "<", ">", "(", ")", ",", ":"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const char = source[at]!;
    if (char === " " || char === "\t") {
      at += 1;
    } else if (char === '"') {
      let value = "";
      let index = at + 1;
      for (;;) {
        if (index >= source.length) throw new ParseFailure("FORMULA_SYNTAX");
        if (source[index] === '"') {
          if (source[index + 1] !== '"') break;
          value += '"';
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ kind: "text", value });
      at = index + 1;
    } else {
      const number = NUMBER_AT.exec(rest);
      const name = NAME_AT.exec(rest);
      if (number !== null) {
        const value = Number(number[0]);
        if (!Number.isFinite(value)) throw new ParseFailure("FORMULA_SYNTAX");
        tokens.push({ kind: "number", value });
        at += number[0].length;
      } else if (name !== null) {
        tokens.push({ kind: "name", value: name[0].toUpperCase() });
        at += name[0].length;
      } else {
        const symbol = SYMBOLS.find((candidate) => rest.startsWith(candidate));
        if (symbol === undefined) throw new ParseFailure("FORMULA_SYNTAX");
        tokens.push({ kind: "symbol", value: symbol });
        at += symbol.length;
      }
    }
  }
  return tokens;
}

function position(name: string): CellPosition | null {
  return REF_LIKE.test(name) ? parseCellRef(name) : null;
}

const COMPARISONS = ["=", "<>", "<", "<=", ">", ">="];

class Parser {
  private at = 0;
  private depth = 0;
  rangeCells = 0;

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseAll(): FormulaNode {
    const node = this.expression();
    if (this.at !== this.tokens.length) throw new ParseFailure("FORMULA_SYNTAX");
    return node;
  }

  private peekSymbol(): string | null {
    const token = this.tokens[this.at];
    return token?.kind === "symbol" ? token.value : null;
  }

  private expectSymbol(symbol: string): void {
    if (this.peekSymbol() !== symbol) throw new ParseFailure("FORMULA_SYNTAX");
    this.at += 1;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_FORMULA_DEPTH) throw new ParseFailure("FORMULA_TOO_DEEP");
  }

  private expression(): FormulaNode {
    this.enter();
    let left = this.additive();
    for (
      let symbol = this.peekSymbol();
      symbol !== null && COMPARISONS.includes(symbol);
      symbol = this.peekSymbol()
    ) {
      this.at += 1;
      left = { type: "binary", operator: symbol as BinaryOperator, left, right: this.additive() };
    }
    this.depth -= 1;
    return left;
  }

  private additive(): FormulaNode {
    let left = this.multiplicative();
    for (
      let symbol = this.peekSymbol();
      symbol === "+" || symbol === "-";
      symbol = this.peekSymbol()
    ) {
      this.at += 1;
      left = { type: "binary", operator: symbol, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): FormulaNode {
    let left = this.unary();
    for (
      let symbol = this.peekSymbol();
      symbol === "*" || symbol === "/";
      symbol = this.peekSymbol()
    ) {
      this.at += 1;
      left = { type: "binary", operator: symbol, left, right: this.unary() };
    }
    return left;
  }

  private unary(): FormulaNode {
    const symbol = this.peekSymbol();
    if (symbol === "+" || symbol === "-") {
      this.at += 1;
      this.enter();
      const operand = this.unary();
      this.depth -= 1;
      return { type: "unary", operator: symbol, operand };
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.tokens[this.at];
    if (token === undefined) throw new ParseFailure("FORMULA_SYNTAX");
    this.at += 1;
    if (token.kind === "number") return { type: "number", value: token.value };
    if (token.kind === "text") return { type: "text", value: token.value };
    if (token.kind === "symbol") {
      if (token.value !== "(") throw new ParseFailure("FORMULA_SYNTAX");
      const inner = this.expression();
      this.expectSymbol(")");
      return inner;
    }
    if (this.peekSymbol() === "(") return this.call(token.value);
    if (this.peekSymbol() === ":") return this.range(token.value);
    if (!REF_LIKE.test(token.value)) return { type: "bad-name" };
    const at = position(token.value);
    return at === null ? { type: "bad-ref" } : { type: "ref", at };
  }

  private range(firstName: string): FormulaNode {
    this.expectSymbol(":");
    const second = this.tokens[this.at];
    if (second?.kind !== "name" || !REF_LIKE.test(second.value) || !REF_LIKE.test(firstName)) {
      throw new ParseFailure("FORMULA_SYNTAX");
    }
    this.at += 1;
    const first = position(firstName);
    const last = position(second.value);
    if (first === null || last === null) return { type: "bad-ref" };
    const from = {
      column: Math.min(first.column, last.column),
      row: Math.min(first.row, last.row),
    };
    const to = { column: Math.max(first.column, last.column), row: Math.max(first.row, last.row) };
    this.rangeCells += (to.column - from.column + 1) * (to.row - from.row + 1);
    if (this.rangeCells > MAX_FORMULA_RANGE_CELLS)
      throw new ParseFailure("FORMULA_RANGE_TOO_LARGE");
    return { type: "range", from, to };
  }

  private call(name: string): FormulaNode {
    this.expectSymbol("(");
    const args: FormulaNode[] = [];
    if (this.peekSymbol() !== ")") {
      for (;;) {
        args.push(this.expression());
        if (this.peekSymbol() !== ",") break;
        this.at += 1;
      }
    }
    this.expectSymbol(")");
    const known = FUNCTION_NAMES.find((candidate) => candidate === name);
    return known === undefined ? { type: "bad-name" } : { type: "call", name: known, args };
  }
}

/** Parses `=…`; a formula is at most 500 code points (`MAX_FORMULA_CODE_POINTS`). */
export function parseFormula(formula: string): FormulaParse {
  if (!formula.startsWith("=")) return { ok: false, code: "FORMULA_PREFIX" };
  if (Array.from(formula).length > MAX_FORMULA_CODE_POINTS)
    return { ok: false, code: "FORMULA_TOO_LONG" };
  try {
    const parser = new Parser(tokenize(formula.slice(1)));
    return { ok: true, node: parser.parseAll() };
  } catch (failure) {
    if (failure instanceof ParseFailure) return { ok: false, code: failure.code };
    throw failure;
  }
}
