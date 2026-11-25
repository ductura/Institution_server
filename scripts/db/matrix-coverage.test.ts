// DAN-1564: every row of db/<database>/tests/002-matrix-coverage.sql names a
// test file that exists, names the table and holds an access assertion; and
// the check itself catches each way a row can be wrong.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { test } from "vitest";

import {
  DATABASES,
  MATRIX_COVERAGE_FILE,
  matrixCoverageFaults,
  namesTable,
  parseMatrixRows,
} from "./index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DB = { ...DATABASES[0]!, testsDir: "t" };
const list = (...rows: string[]) =>
  [
    "CREATE VIEW pg_temp.matrix_row AS",
    "  SELECT v.schema_name, v.table_name, v.matrix_file FROM (VALUES",
    ...rows.map((row, index) => `    ${row}${index < rows.length - 1 ? "," : ""}`),
    "  ) AS v (schema_name, table_name, matrix_file);",
  ].join("\n");

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "matrix-"));
  mkdirSync(join(root, "t"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "t", name), text);
  return root;
}

test("every row of every database names a test file that names the table and asserts access", () => {
  for (const database of DATABASES) {
    assert.deepEqual(matrixCoverageFaults(database, ROOT), [], database.name);
  }
});

test("the list of each database is not empty and its count matches the count the pgTAP file asserts", () => {
  for (const database of DATABASES) {
    const sql = readFileSync(resolve(ROOT, database.testsDir, MATRIX_COVERAGE_FILE), "utf8");
    const rows = parseMatrixRows(sql);
    assert.ok(rows.length > 0, database.name);
    assert.match(sql, new RegExp(`FROM pg_temp\\.matrix_row\\), ${rows.length}, `), database.name);
  }
});

test("the three files differ only in their list and its count", () => {
  const body = (name: string) => {
    const sql = readFileSync(resolve(ROOT, `db/${name}/tests`, MATRIX_COVERAGE_FILE), "utf8");
    return sql
      .split("\n")
      .filter((line) => !/^ {4}\('/.test(line))
      .join("\n")
      .replace(/matrix_row\), \d+, /, "matrix_row), N, ");
  };
  assert.equal(body("logs"), body("main"));
  assert.equal(body("legal"), body("main"));
});

test("a row is refused when its file is missing, is the list itself, or does not test the table", () => {
  const good = "SELECT throws_ok($$ DELETE FROM app.thing $$, '42501');";
  const faults = (rows: string[], files: Record<string, string>) =>
    matrixCoverageFaults(DB, tree({ [MATRIX_COVERAGE_FILE]: list(...rows), ...files }));

  assert.deepEqual(faults(["('app', 'thing', '010-thing.sql')"], { "010-thing.sql": good }), []);
  assert.deepEqual(faults(["('app', 'thing', '010-thing.sql')"], {}), [
    "app.thing: t/010-thing.sql does not exist",
  ]);
  assert.deepEqual(faults(["('app', 'thing', '002-matrix-coverage.sql')"], {}), [
    "app.thing: the list cannot name itself",
  ]);
  assert.deepEqual(faults(["('app', 'other', '010-thing.sql')"], { "010-thing.sql": good }), [
    "app.other: t/010-thing.sql does not name the table",
  ]);
  assert.deepEqual(
    faults(["('app', 'thing', '010-thing.sql')"], {
      "010-thing.sql": "SELECT ok(true, 'app.thing');",
    }),
    ["app.thing: t/010-thing.sql holds no access assertion"],
  );
  assert.deepEqual(
    faults(["('app', 'thing', '010-thing.sql')", "('app', 'thing', '010-thing.sql')"], {
      "010-thing.sql": good,
    }),
    ["app.thing: listed twice"],
  );
  assert.deepEqual(matrixCoverageFaults(DB, tree({ "010-thing.sql": good })), [
    "t/002-matrix-coverage.sql: missing",
  ]);
});

test("a list that cannot be read whole is an error, never a shorter list", () => {
  assert.throws(() => parseMatrixRows("SELECT 1;"), /the list was not found/);
  assert.throws(
    () => parseMatrixRows(list("('app', 'thing', '010-thing.sql') -- later")),
    /not a row/,
  );
  assert.throws(() => parseMatrixRows(list("('App', 'thing', '010-thing.sql')")), /not a row/);
  assert.deepEqual(
    parseMatrixRows(list("('app', 'a', '010-a.sql')", "('app', 'b', '011-b.sql')")),
    [
      { schema: "app", table: "a", file: "010-a.sql" },
      { schema: "app", table: "b", file: "011-b.sql" },
    ],
  );
});

test("a table is named by its qualified name or as a quoted name; a bare name counts only in public", () => {
  const row = { schema: "app", table: "thing", file: "x.sql" };
  assert.equal(namesTable("FROM app.thing WHERE", row), true);
  assert.equal(namesTable("ARRAY['thing', 'other']", row), true);
  assert.equal(namesTable("FROM app.thing_event", row), false);
  assert.equal(namesTable("FROM other.thing", row), false);
  assert.equal(namesTable("FROM thing", row), false);
  assert.equal(namesTable("FROM thing", { ...row, schema: "public" }), true);
});
