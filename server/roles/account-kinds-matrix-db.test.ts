// DAN-825 (S-1J-d): the pgTAP matrix account kind x action of
// db/main/tests/135-account-kinds-matrix.sql has exactly one row for every kind
// of ACCOUNT_KINDS and action of ACTIONS, in that order, and every outcome
// keeps to the scope of permissions.ts. A new kind or action without its row
// fails here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_KINDS, loginOf } from "./account-kinds.ts";
import { ACTIONS, scopeOf } from "./permissions.ts";

const MATRIX_PATH = resolve(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "main",
  "tests",
  "135-account-kinds-matrix.sql",
);
const START = "-- account-kinds-matrix:begin";
const END = "-- account-kinds-matrix:end";
const ROW =
  /^ {2}\('([a-z_]+)', '([a-z_]+)', '(allowed|refused|not_built)', (NULL|'[A-Za-z0-9 .,:()=_-]+')\),?$/;

type Row = { kind: string; action: string; outcome: string; reason: string | null };

/** Rows of the matrix in the SQL file, or the problems found reading it. */
function readMatrix(sql: string): { rows: Row[]; problems: string[] } {
  const problems: string[] = [];
  if (sql.split(START).length !== 2 || sql.split(END).length !== 2) {
    return { rows: [], problems: ["expected one start and one end marker"] };
  }
  const body = sql.slice(sql.indexOf(START) + START.length, sql.indexOf(END));
  const rows: Row[] = [];
  const lines = body.replace(/^\n+|\n+$/g, "").split("\n");
  lines.forEach((line, index) => {
    const match = ROW.exec(line);
    const [, kind, action, outcome, reason] = match ?? [];
    if (
      kind === undefined ||
      action === undefined ||
      outcome === undefined ||
      reason === undefined
    ) {
      problems.push(`not a matrix row: ${JSON.stringify(line)}`);
      return;
    }
    if (line.endsWith(",") !== index < lines.length - 1)
      problems.push(`comma: ${JSON.stringify(line)}`);
    rows.push({ kind, action, outcome, reason: reason === "NULL" ? null : reason.slice(1, -1) });
  });
  return { rows, problems };
}

/** Rows that break the code: wrong order or set, an outcome against its scope, a reason out of place. */
function checkRows(rows: readonly Row[]): string[] {
  const problems: string[] = [];
  const expected = ACCOUNT_KINDS.flatMap((kind) => ACTIONS.map((action) => `${kind} ${action}`));
  const actual = rows.map((row) => `${row.kind} ${row.action}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    problems.push("rows are not ACCOUNT_KINDS x ACTIONS in order");
  for (const { kind, action, outcome, reason } of rows) {
    const cell = `${kind} x ${action}`;
    const scope = scopeOf(kind, action);
    if (outcome === "allowed" && scope === "none") problems.push(`${cell}: allowed on none`);
    if (outcome === "refused" && scope !== "none") problems.push(`${cell}: refused on ${scope}`);
    if (loginOf(kind) === "not_built" && outcome !== "not_built")
      problems.push(`${cell}: the kind has no login`);
    if ((outcome === "not_built") !== (reason !== null))
      problems.push(`${cell}: reason only on not_built`);
  }
  return problems;
}

const row = (kind: string, action: string, outcome: string, reason = "NULL") =>
  `  ('${kind}', '${action}', '${outcome}', ${reason})`;
const wrap = (lines: readonly string[]) => `x\n${START}\n${lines.join(",\n")}\n\n${END}\n;`;
/** Rows of the real matrix as lines, to be changed one at a time. */
const realLines = () =>
  readMatrix(readFileSync(MATRIX_PATH, "utf8")).rows.map((r) =>
    row(r.kind, r.action, r.outcome, r.reason === null ? "NULL" : `'${r.reason}'`),
  );

describe("account kinds x actions in the pgTAP matrix", () => {
  it("has one row for every kind and action, in order, each keeping to its scope", () => {
    const { rows, problems } = readMatrix(readFileSync(MATRIX_PATH, "utf8"));
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(ACCOUNT_KINDS.length * ACTIONS.length);
    expect(checkRows(rows)).toEqual([]);
  });

  it("round-trips the real matrix through the lines the other cases change", () => {
    expect(checkRows(readMatrix(wrap(realLines())).rows)).toEqual([]);
  });

  it("fails on a missing, extra, duplicated or reordered row", () => {
    const lines = realLines();
    const check = (changed: string[]) => {
      const { rows, problems } = readMatrix(wrap(changed));
      return [...problems, ...checkRows(rows)];
    };
    expect(check(lines.slice(1))).not.toEqual([]);
    expect(check(lines.slice(0, -1))).not.toEqual([]);
    expect(check([...lines, row("student", "new_action", "refused")])).not.toEqual([]);
    expect(check([...lines, row("operator", "read_own_work", "refused")])).not.toEqual([]);
    expect(check([lines[0] ?? "", ...lines])).not.toEqual([]);
    expect(check([lines[1] ?? "", lines[0] ?? "", ...lines.slice(2)])).not.toEqual([]);
  });

  it("fails on an outcome against the scope of permissions.ts", () => {
    const one = (kind: string, action: string, outcome: string, reason = "NULL") =>
      checkRows(readMatrix(wrap([row(kind, action, outcome, reason)])).rows).filter(
        (p) => !p.startsWith("rows"),
      );
    expect(one("student", "change_course_settings", "allowed")).toEqual([
      "student x change_course_settings: allowed on none",
    ]);
    expect(one("teacher", "read_students_work", "refused")).toEqual([
      "teacher x read_students_work: refused on relation",
    ]);
    expect(one("app_admin", "change_system_settings", "allowed")).toEqual([
      "app_admin x change_system_settings: the kind has no login",
    ]);
    expect(one("student", "delete_draft", "not_built")).toEqual([
      "student x delete_draft: reason only on not_built",
    ]);
    expect(one("student", "read_own_work", "allowed", "'why'")).toEqual([
      "student x read_own_work: reason only on not_built",
    ]);
    // An unknown or inherited name has no login and is not in the order.
    expect(one("__proto__", "read_own_work", "refused")).toEqual([
      "__proto__ x read_own_work: the kind has no login",
    ]);
    expect(one("student", "constructor", "allowed")).toEqual([
      "student x constructor: allowed on none",
    ]);
    expect(readMatrix(wrap([row("student", "toString", "allowed")])).problems).not.toEqual([]);
    expect(
      checkRows(readMatrix(wrap([row("toString", "read_own_work", "refused")])).rows),
    ).toContain("rows are not ACCOUNT_KINDS x ACTIONS in order");
  });

  it("refuses a line that is not exactly a row", () => {
    const good = row("student", "read_own_work", "allowed");
    for (const bad of [
      `${good}\r`,
      good.replace("  (", "\t("),
      good.replace(", 'allowed'", ",\u00a0'allowed'"),
      good.replace("allowed", "allowed\u007f"),
      good.replace("allowed", "maybe"),
      good.replace("NULL", "'C:\\\\matrix'"),
      `-- ${good}`,
      good.replace("NULL", "''"),
    ]) {
      expect(readMatrix(wrap([bad])).problems, JSON.stringify(bad)).not.toEqual([]);
    }
    expect(readMatrix(`${START}\n${START}\n${END}`).problems).toEqual([
      "expected one start and one end marker",
    ]);
    expect(readMatrix(`x\n${START}\n${good}\n${END}`).problems).toEqual([]);
    expect(readMatrix(`x\n${START}\n${good},\n${END}`).problems).not.toEqual([]);
  });
});
