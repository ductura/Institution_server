// DAN-1564: the static half of the matrix coverage check. The pgTAP file
// db/<database>/tests/002-matrix-coverage.sql holds, inside the database, that
// every table has a row in its list; a row names the pgTAP file with the
// table's access tests. Nothing in the database can see that file, so this
// module reads the list from the SQL text and checks each row against the
// file it names. No database is needed.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Database } from "./databases.ts";
import { testFiles } from "./pgtap.ts";

/** The pgTAP file of the list, the same name in every database. */
export const MATRIX_COVERAGE_FILE = "002-matrix-coverage.sql";

export type MatrixRow = { schema: string; table: string; file: string };

const ROW = /^\s*\('([a-z_][a-z0-9_]*)', '([a-z_][a-z0-9_]*)', '([0-9a-z-]+\.sql)'\),?$/;
const LIST_START = /^CREATE VIEW pg_temp\.matrix_row AS$/;
const LIST_END = /^\s*\) AS v \(schema_name, table_name, matrix_file\);$/;

/**
 * The rows of the list in `sql`. Throws when the list is missing or holds a
 * line that is not a row, so a row written in another form is never skipped.
 */
export function parseMatrixRows(sql: string): MatrixRow[] {
  const lines = sql.split("\n");
  const start = lines.findIndex((line) => LIST_START.test(line));
  const end = lines.findIndex((line, index) => index > start && LIST_END.test(line));
  if (start < 0 || end < 0) throw new Error("matrix coverage: the list was not found");
  // The line after the start opens the VALUES list.
  return lines.slice(start + 2, end).map((line) => {
    const match = ROW.exec(line);
    if (!match) throw new Error(`matrix coverage: not a row: ${line.trim()}`);
    return { schema: match[1]!, table: match[2]!, file: match[3]! };
  });
}

/** An assertion about who may do what: a privilege read from the catalogue, or a refused statement. */
const ACCESS_ASSERTION = /\b(has_table_privilege|has_any_column_privilege|throws_ok)\b/;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `sql` names the table: schema-qualified, or as a quoted name, the
 * form the pinned catalogue lists use. In a database whose tables all live in
 * `public` the bare name counts too, as its tests write it.
 */
export function namesTable(sql: string, row: MatrixRow): boolean {
  const table = escaped(row.table);
  const forms = [`\\b${escaped(row.schema)}\\.${table}\\b`, `'${table}'`];
  if (row.schema === "public") forms.push(`\\b${table}\\b`);
  return forms.some((form) => new RegExp(form).test(sql));
}

/**
 * Why the list of `database` does not hold, one line per fault; empty when
 * every row names a test file of that database which names the table and
 * holds an access assertion.
 */
export function matrixCoverageFaults(database: Database, root: string): string[] {
  // testFiles joins with the platform separator; the list names files with "/".
  const files = new Set(
    testFiles(database.testsDir, root).map((file) => file.split(sep).join("/")),
  );
  const path = `${database.testsDir}/${MATRIX_COVERAGE_FILE}`;
  if (!files.has(path)) return [`${path}: missing`];
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");
  const faults: string[] = [];
  const seen = new Set<string>();
  for (const row of parseMatrixRows(read(path))) {
    const name = `${row.schema}.${row.table}`;
    const target = `${database.testsDir}/${row.file}`;
    if (seen.has(name)) faults.push(`${name}: listed twice`);
    seen.add(name);
    if (row.file === MATRIX_COVERAGE_FILE) faults.push(`${name}: the list cannot name itself`);
    else if (!files.has(target)) faults.push(`${name}: ${target} does not exist`);
    else {
      const sql = read(target);
      if (!namesTable(sql, row)) faults.push(`${name}: ${target} does not name the table`);
      if (!ACCESS_ASSERTION.test(sql)) faults.push(`${name}: ${target} holds no access assertion`);
    }
  }
  return faults;
}
