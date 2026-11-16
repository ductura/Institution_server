// S-1F-d (DAN-797): the pgTAP tests of one database of scripts/db/databases.ts,
// as `pnpm test:db:<name>` runs them:
//
//   node scripts/db/pgtap.ts logs|legal|main
//
// pg_prove reaches the database through the standard PG* variables (PGHOST,
// PGPORT, PGUSER, PGDATABASE); CI sets them per step. pg_prove on its own exits
// 0 when it finds no test (`Result: NOTESTS`) and when a file only plans
// `1..0`, so this guard fails unless every test file of the database ran, each
// with at least one test, and the run passed.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { databaseNamed, type Database } from "./databases.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/** Every `.sql` file under `dir`, at any depth, as `pg_prove --recurse --ext .sql` finds them. */
export function testFiles(dir: string, root = ROOT): string[] {
  let entries;
  try {
    entries = readdirSync(resolve(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return testFiles(path, root);
      return entry.isFile() && entry.name.endsWith(".sql") ? [path] : [];
    })
    .sort();
}

/**
 * The pg_prove argv for a database's tests, program left out. `--norc` keeps
 * a .proverc out (`--ignore-exit` there would hide a psql error); with
 * `--directives` pg_prove prints every SKIP and TODO, which it counts as passed.
 */
export function pgtapArgs(database: Database): string[] {
  return ["--norc", "--recurse", "--ext", ".sql", "--failures", "--directives", database.testsDir];
}

/**
 * Why a pg_prove run over `files` does not count as passed, or null when it
 * does: exit 0, `Result: PASS`, every file run, at least one test, no file
 * skipped whole, no test skipped or marked TODO.
 */
export function pgtapFailure(files: number, status: number | null, output: string): string | null {
  if (files === 0) return "no pgTAP test file found";
  if (status !== 0) return `pg_prove exited with ${String(status)}`;
  if (!/^Result: PASS$/m.test(output)) return "pg_prove did not report Result: PASS";
  const summary = /^Files=(\d+), Tests=(\d+),/m.exec(output);
  if (!summary) return "pg_prove printed no summary";
  if (Number(summary[1]) !== files) return `pg_prove ran ${summary[1]} of ${files} test files`;
  if (Number(summary[2]) === 0) return "pg_prove ran no test";
  if (/ \.+ skipped/.test(output)) return "a test file was skipped whole (plan 1..0)";
  // TAP: a directive is `#`, any whitespace, then SKIP or TODO, in any case.
  if (/^(?:not )?ok\b[^\n]*#\s*(?:SKIP|TODO)/im.test(output))
    return "a test was skipped or marked TODO";
  return null;
}

export type PgtapRun = (args: string[]) => { status: number | null; output: string };

/** Runs the pgTAP tests of the database called `name`; resolves to an exit code. */
export function runPgtap(name: string, run: PgtapRun, log = console.error): number {
  const database = databaseNamed(name);
  const files = testFiles(database.testsDir);
  const result = files.length === 0 ? { status: null, output: "" } : run(pgtapArgs(database));
  const failure = pgtapFailure(files.length, result.status, result.output);
  if (failure === null) return 0;
  log(`pgTAP ${database.name} (${database.testsDir}): ${failure}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  if (name === undefined || rest.length > 0) {
    console.error("usage: pgtap.ts <database>");
    process.exit(2);
  }
  process.exitCode = runPgtap(name, (args) => {
    const child = spawnSync("pg_prove", args, { cwd: ROOT, encoding: "utf8" });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    process.stdout.write(output);
    return { status: child.error ? null : child.status, output };
  });
}
