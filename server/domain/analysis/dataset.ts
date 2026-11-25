// SRV-V15-SKUP (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.3): the check of a
// dataset that arrives in the body of an analysis request. Pure and total: a bad
// input never throws, it returns the first problem as a structured error. The
// dataset is never stored; this file only decides whether it may be computed on.
// Limits are named constants because the catalogue route reports the same numbers
// (a test of the HTTP task asserts that they are equal).

export const DATASET_LIMITS = Object.freeze({
  maxRows: 500,
  maxColumns: 12,
  maxCellLength: 64,
  maxColumnNameLength: 40,
  maxBodyBytes: 131072,
});

/**
 * Largest absolute value of a numeric cell. Assumption (not in the contract text):
 * without a bound, squares in a standard deviation overflow to Infinity, which is
 * not JSON. 1e15 is far above any invented survey and keeps every sum finite.
 */
export const MAX_ABS_NUMBER = 1e15;

export type ColumnKind = "numeric" | "category";
export type Cell = number | string | null;
export type DatasetColumn = { readonly name: string; readonly kind: ColumnKind };
export type Dataset = {
  readonly columns: readonly DatasetColumn[];
  readonly rows: readonly (readonly Cell[])[];
};

export type DatasetProblem =
  | "not_an_object"
  | "unknown_field"
  | "columns_invalid"
  | "no_columns"
  | "too_many_columns"
  | "column_invalid"
  | "column_name_invalid"
  | "column_name_too_long"
  | "column_name_duplicate"
  | "column_kind_invalid"
  | "rows_invalid"
  | "no_rows"
  | "too_many_rows"
  | "row_invalid"
  | "row_length_mismatch"
  | "cell_not_numeric"
  | "cell_not_finite"
  | "cell_too_large"
  | "cell_not_text"
  | "cell_empty_text"
  | "cell_too_long"
  | "text_invalid"
  | "unreadable";

export type DatasetError = {
  readonly code: "invalid_input";
  readonly problem: DatasetProblem;
  /** Zero-based row of the problem, when it belongs to a cell or row. */
  readonly row?: number;
  /** Zero-based column of the problem, when it belongs to a column or cell. */
  readonly column?: number;
};

export type DatasetResult =
  | { readonly ok: true; readonly value: Dataset }
  | { readonly ok: false; readonly error: DatasetError };

/**
 * A name that is a member of `Object.prototype` (`__proto__`, `toString`, ...) would
 * shadow it if a consumer ever indexes an object by column name.
 */
function isPrototypeName(name: string): boolean {
  return name === "prototype" || name in Object.prototype;
}

class Bad extends Error {
  readonly detail: DatasetError;
  constructor(problem: DatasetProblem, row?: number, column?: number) {
    super(problem);
    this.detail = {
      code: "invalid_input",
      problem,
      ...(row === undefined ? {} : { row }),
      ...(column === undefined ? {} : { column }),
    };
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Bad("unreadable");
  return descriptor.value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Bad("unknown_field");
  }
}

/** Items of a real, dense array, read without trusting getters. */
function items(value: unknown, problem: DatasetProblem, row?: number): unknown[] {
  if (!Array.isArray(value)) throw new Bad(problem, row);
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor === undefined || !("value" in descriptor)) throw new Bad(problem, row);
    out.push(descriptor.value);
  }
  return out;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Length in Unicode code points, so one letter or emoji counts once. */
function length(text: string): number {
  return [...text].length;
}

function column(raw: unknown, index: number): DatasetColumn {
  if (!isPlain(raw)) throw new Bad("column_invalid", undefined, index);
  onlyKeys(raw, ["name", "kind"]);
  const name = own(raw, "name");
  const kind = own(raw, "kind");
  if (typeof name !== "string" || name.length === 0 || hasLoneSurrogate(name)) {
    throw new Bad("column_name_invalid", undefined, index);
  }
  if (isPrototypeName(name)) throw new Bad("column_name_invalid", undefined, index);
  if (length(name) > DATASET_LIMITS.maxColumnNameLength) {
    throw new Bad("column_name_too_long", undefined, index);
  }
  if (kind !== "numeric" && kind !== "category") {
    throw new Bad("column_kind_invalid", undefined, index);
  }
  return Object.freeze({ name, kind });
}

function cell(raw: unknown, kind: ColumnKind, row: number, col: number): Cell {
  if (raw === null) return null;
  if (kind === "numeric") {
    if (typeof raw !== "number") throw new Bad("cell_not_numeric", row, col);
    if (!Number.isFinite(raw)) throw new Bad("cell_not_finite", row, col);
    if (Math.abs(raw) > MAX_ABS_NUMBER) throw new Bad("cell_too_large", row, col);
    // -0 and 0 are one value: they must give one fingerprint and one result.
    return raw === 0 ? 0 : raw;
  }
  if (typeof raw !== "string") throw new Bad("cell_not_text", row, col);
  // A missing value is `null`, never an empty string: one way to say it.
  if (raw.length === 0) throw new Bad("cell_empty_text", row, col);
  if (hasLoneSurrogate(raw)) throw new Bad("text_invalid", row, col);
  if (length(raw) > DATASET_LIMITS.maxCellLength) throw new Bad("cell_too_long", row, col);
  return raw;
}

/**
 * Check an unknown value as a dataset. Returns a deep-frozen copy (nothing aliases
 * the input) or the first problem found; never throws. An empty dataset (no
 * rows) is refused: there is nothing to compute on.
 */
export function validateDataset(input: unknown): DatasetResult {
  try {
    if (!isPlain(input)) throw new Bad("not_an_object");
    onlyKeys(input, ["columns", "rows"]);

    const rawColumns = items(own(input, "columns"), "columns_invalid");
    if (rawColumns.length === 0) throw new Bad("no_columns");
    if (rawColumns.length > DATASET_LIMITS.maxColumns) throw new Bad("too_many_columns");
    const columns = rawColumns.map(column);
    const seen = new Set<string>();
    columns.forEach((c, index) => {
      if (seen.has(c.name)) throw new Bad("column_name_duplicate", undefined, index);
      seen.add(c.name);
    });

    const rawRows = items(own(input, "rows"), "rows_invalid");
    if (rawRows.length === 0) throw new Bad("no_rows");
    if (rawRows.length > DATASET_LIMITS.maxRows) throw new Bad("too_many_rows");
    const rows = rawRows.map((rawRow, r) => {
      const cells = items(rawRow, "row_invalid", r);
      if (cells.length !== columns.length) throw new Bad("row_length_mismatch", r);
      return Object.freeze(cells.map((raw, c) => cell(raw, columns[c]?.kind ?? "category", r, c)));
    });

    return {
      ok: true,
      value: Object.freeze({ columns: Object.freeze(columns), rows: Object.freeze(rows) }),
    };
  } catch (error) {
    if (error instanceof Bad) return { ok: false, error: Object.freeze(error.detail) };
    return { ok: false, error: Object.freeze({ code: "invalid_input", problem: "unreadable" }) };
  }
}
