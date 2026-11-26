// S-1F-d (DAN-797): the guard around pg_prove. pg_prove exits 0 with no test
// file and with a file that plans 1..0, so these runs must fail all the same.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { DATABASES, databaseNamed, pgtapArgs, pgtapFailure, runPgtap, testFiles } from "./index.ts";

const PASS = (files: number, tests: number) =>
  `db/x/tests/a.sql .. ok\nAll tests successful.\nFiles=${files}, Tests=${tests},  0 wallclock secs\nResult: PASS\n`;

test("every database has a pgTAP directory with at least one test file, which pg_prove gets", () => {
  for (const entry of DATABASES) {
    assert.equal(entry.testsDir, `db/${entry.name}/tests`);
    assert.ok(testFiles(entry.testsDir).length > 0, `${entry.name}: no test file`);
    assert.deepEqual(pgtapArgs(entry), [
      "--norc",
      "--recurse",
      "--ext",
      ".sql",
      "--failures",
      "--directives",
      entry.testsDir,
    ]);
  }
  const extra: Record<string, string[]> = {
    logs: [
      "db/logs/tests/010-log-entry.sql",
      "db/logs/tests/020-log-chain.sql",
      "db/logs/tests/030-metric-sample.sql",
      "db/logs/tests/040-operator-log.sql",
    ],
    legal: ["db/legal/tests/010-legal-text-version.sql"],
  };
  for (const name of ["logs", "legal"]) {
    assert.deepEqual(testFiles(databaseNamed(name).testsDir), [
      `db/${name}/tests/000-rls-everywhere.sql`,
      `db/${name}/tests/000-roles.sql`,
      `db/${name}/tests/002-matrix-coverage.sql`,
      ...(extra[name] ?? []),
    ]);
  }
});

test("testFiles finds .sql files at any depth, as pg_prove --recurse --ext .sql does, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "pgtap-"));
  mkdirSync(join(root, "t/deeper"), { recursive: true });
  for (const file of ["t/b.sql", "t/a.sql", "t/deeper/c.sql", "t/notes.md", "t/d.sql.bak"]) {
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(testFiles("t", root), ["t/a.sql", "t/b.sql", "t/deeper/c.sql"]);
  assert.deepEqual(testFiles("missing", root), []);
  mkdirSync(join(root, "empty"));
  assert.deepEqual(testFiles("empty", root), []);
});

test("a run counts only when every file ran, something was tested and pg_prove passed", () => {
  assert.equal(pgtapFailure(2, 0, PASS(2, 36)), null);
  const cases: [number, number | null, string, RegExp][] = [
    [0, 0, PASS(0, 0), /no pgTAP test file found/],
    [2, 1, PASS(2, 36), /exited with 1/],
    [2, null, "", /exited with null/],
    [2, 0, "Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n", /did not report Result: PASS/],
    [2, 0, "Result: PASS\n", /no summary/],
    [3, 0, PASS(2, 36), /ran 2 of 3 test files/],
    [1, 0, PASS(1, 0), /ran no test/],
    [2, 0, `db/x/tests/b.sql .. skipped: (no reason given)\n${PASS(2, 21)}`, /skipped whole/],
    // The padding pg_prove really prints, seen in the local run of DAN-797.
    [
      3,
      0,
      `db/x/tests/999-empty.sql ........... skipped: (no reason given)\n${PASS(3, 36)}`,
      /skipped whole/,
    ],
    [1, 0, "Result: PASS (not at the start)\nFiles=1, Tests=3,\n", /did not report Result: PASS/],
    // Findings of the attack run: a name with a space, and SKIP or TODO, which
    // pg_prove counts as passed and prints only with --directives.
    [3, 0, `db/x/tests/900 c.sql ..... skipped: whole file\n${PASS(3, 36)}`, /skipped whole/],
    [2, 0, `db/x/tests/a.sql ..\nok 1 # SKIP x\n${PASS(2, 36)}`, /skipped or marked TODO/],
    [2, 0, `db/x/tests/a.sql ..\nok 2 # skip later\n${PASS(2, 36)}`, /skipped or marked TODO/],
    [2, 0, `db/x/tests/a.sql ..\nnot ok 2 - y # TODO t\n${PASS(2, 36)}`, /skipped or marked TODO/],
    // QA cxcqs86: TAP allows no or several spaces after #, in any case.
    [2, 0, `db/x/tests/a.sql ..\nnot ok 1 #TODO kasnije\n${PASS(2, 36)}`, /skipped or marked TODO/],
    [2, 0, `db/x/tests/a.sql ..\nok 1 #  SKIP razlog\n${PASS(2, 36)}`, /skipped or marked TODO/],
    [2, 0, `db/x/tests/a.sql ..\nok 1 #skip\n${PASS(2, 36)}`, /skipped or marked TODO/],
    [2, 0, `db/x/tests/a.sql ..\nok 1\t#\tTodo later\n${PASS(2, 36)}`, /skipped or marked TODO/],
  ];
  for (const [files, status, output, error] of cases) {
    assert.match(pgtapFailure(files, status, output) ?? "", error, output);
  }
});

test("runPgtap runs pg_prove over the database's directory and fails on any failure", () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const files = testFiles("db/logs/tests").length;
  const ok = (args: string[]) => (calls.push(args), { status: 0, output: PASS(files, 36) });
  assert.equal(runPgtap("logs", ok, log), 0);
  assert.deepEqual(calls, [pgtapArgs(databaseNamed("logs"))]);
  assert.deepEqual(logs, []);

  assert.equal(
    runPgtap("legal", () => ({ status: 1, output: "Result: FAIL\n" }), log),
    1,
  );
  assert.match(logs.at(-1) ?? "", /^pgTAP legal \(db\/legal\/tests\): pg_prove exited with 1$/);
  assert.equal(
    runPgtap("legal", () => ({ status: 0, output: "Result: NOTESTS\n" }), log),
    1,
  );
  assert.throws(() => runPgtap("audit", ok, log), /unknown database "audit"/);
});
