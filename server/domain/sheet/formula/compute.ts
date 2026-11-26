/**
 * Computing a sheet: the result of every filled cell (decision 3 of the val 14
 * review; a formula cell stores no result, decision 4). The order of
 * evaluation follows what each formula reads. A cell that takes part in a
 * cycle, or reads itself, is #CIRC!; the cycle is found from the references
 * written in the formulas, all branches of IF included, so the answer never
 * depends on which cell is computed first.
 */

import { parseCellRef, type Sheet, type SheetDocument } from "../index.ts";
import { evaluateFormula, type ComputedCell, type FormulaValue } from "./evaluate.ts";
import { parseFormula, type FormulaNode } from "./parse.ts";

const CELL_KEY_COLUMNS = 32;

function key(column: number, row: number): number {
  return row * CELL_KEY_COLUMNS + column;
}

type Entry = {
  ref: string;
  column: number;
  row: number;
  /** Parsed formula, or `null` for a constant cell. */
  node: FormulaNode | "invalid" | null;
  constant: FormulaValue;
  dependencies: number[];
};

function collectDependencies(
  node: FormulaNode,
  sheet: Sheet,
  formulaKeys: Set<number>,
  out: Set<number>,
): void {
  switch (node.type) {
    case "ref": {
      const id = key(node.at.column, node.at.row);
      if (node.at.column <= sheet.columns && node.at.row <= sheet.rows && formulaKeys.has(id))
        out.add(id);
      return;
    }
    case "range":
      if (node.to.column > sheet.columns || node.to.row > sheet.rows) return;
      for (let row = node.from.row; row <= node.to.row; row += 1) {
        for (let column = node.from.column; column <= node.to.column; column += 1) {
          const id = key(column, row);
          if (formulaKeys.has(id)) out.add(id);
        }
      }
      return;
    case "unary":
      collectDependencies(node.operand, sheet, formulaKeys, out);
      return;
    case "binary":
      collectDependencies(node.left, sheet, formulaKeys, out);
      collectDependencies(node.right, sheet, formulaKeys, out);
      return;
    case "call":
      for (const arg of node.args) collectDependencies(arg, sheet, formulaKeys, out);
      return;
    default:
      return;
  }
}

// Strongly connected components, iterative, dependencies first.
function components(entries: Map<number, Entry>): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;
  for (const start of entries.keys()) {
    if (index.has(start)) continue;
    const work: { id: number; next: number }[] = [{ id: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const dependencies = entries.get(frame.id)!.dependencies;
      if (frame.next < dependencies.length) {
        const to = dependencies[frame.next]!;
        frame.next += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: number[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          group.push(member);
          if (member === frame.id) break;
        }
        result.push(group);
      }
    }
  }
  return result;
}

/** Result of every filled cell of `sheet`, by A1 reference. */
export function computeSheet(sheet: Sheet): Record<string, ComputedCell> {
  const entries = new Map<number, Entry>();
  const constants = new Map<number, FormulaValue>();
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const at = parseCellRef(ref);
    if (at === null) continue;
    const id = key(at.column, at.row);
    if (cell.formula === undefined) {
      constants.set(
        id,
        typeof cell.value === "number"
          ? { type: "number", value: cell.value }
          : { type: "text", value: cell.value },
      );
      continue;
    }
    const parsed = parseFormula(cell.formula);
    entries.set(id, {
      ref,
      ...at,
      node: parsed.ok ? parsed.node : "invalid",
      constant: { type: "empty" },
      dependencies: [],
    });
  }
  const formulaKeys = new Set(entries.keys());
  for (const entry of entries.values()) {
    if (entry.node === null || entry.node === "invalid") continue;
    const found = new Set<number>();
    collectDependencies(entry.node, sheet, formulaKeys, found);
    entry.dependencies = [...found];
  }

  const values = new Map<number, FormulaValue>(constants);
  const circular: ComputedCell = { type: "error", code: "#CIRC!" };
  const context = {
    rows: sheet.rows,
    columns: sheet.columns,
    cell: (column: number, row: number): FormulaValue =>
      values.get(key(column, row)) ?? { type: "empty" },
  };
  for (const group of components(entries)) {
    const first = entries.get(group[0]!)!;
    const cyclic = group.length > 1 || first.dependencies.includes(group[0]!);
    for (const id of group) {
      const entry = entries.get(id)!;
      if (cyclic) values.set(id, circular);
      else if (entry.node === "invalid" || entry.node === null)
        values.set(id, { type: "error", code: "#VALUE!" });
      else values.set(id, evaluateFormula(entry.node, context));
    }
  }

  const computed: Record<string, ComputedCell> = {};
  for (const ref of Object.keys(sheet.cells)) {
    const at = parseCellRef(ref);
    const value = at === null ? undefined : values.get(key(at.column, at.row));
    if (value !== undefined && value.type !== "empty") computed[ref] = value;
  }
  return computed;
}

/** Results of every sheet of a document, in the order of its sheets. */
export function computeSheetDocument(
  doc: SheetDocument,
): { sheetId: string; cells: Record<string, ComputedCell> }[] {
  return doc.sheets.map((sheet) => ({ sheetId: sheet.id, cells: computeSheet(sheet) }));
}
