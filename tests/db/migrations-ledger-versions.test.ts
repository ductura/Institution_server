import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { expect, test } from "vitest";

import { DATABASES, databaseNamed, readMigrations, renderLedger } from "../../scripts/db/index.ts";

const SCRIPT = path.resolve("scripts/db/migrations-ledger.ts");
const FIRST = "20261001000000_first.sql";
const DISTINCT = "20261002000000_distinct.sql";
const DUPLICATE = "20261001000000_second.sql";

function fixture(cleanup: (callback: () => void) => void) {
  const dir = mkdtempDisposableSync(path.join(tmpdir(), "migrations-ledger-versions-"));
  cleanup(() => dir.remove());
  for (const { migrationsDir } of DATABASES)
    mkdirSync(path.join(dir.path, migrationsDir), { recursive: true });

  const put = (database: string, name: string) =>
    writeFileSync(path.join(dir.path, databaseNamed(database).migrationsDir, name), "select 1;\n");
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir.path, encoding: "utf8" });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir.path, encoding: "utf8" }).trim();
  const ledgers = () => DATABASES.map(({ ledger }) => readFileSync(path.join(dir.path, ledger)));

  for (const { name } of DATABASES) put(name, FIRST);
  return { dir: dir.path, put, cli, git, ledgers };
}

test("the ledger accepts distinct versions and reuse of a version across databases", ({
  onTestFinished,
}) => {
  const { cli, put } = fixture(onTestFinished);
  put("main", DISTINCT);
  expect(cli("--write").status).toBe(0);
  expect(cli().status).toBe(0);
});

test("the ledger reports both files and refuses every write on a duplicate in one database", ({
  onTestFinished,
}) => {
  const { dir, cli, put, git, ledgers } = fixture(onTestFinished);
  put("legal", DUPLICATE);

  // Even a byte-correct ledger and an unchanged base must fail.
  for (const { migrationsDir, ledger } of DATABASES) {
    writeFileSync(
      path.join(dir, ledger),
      renderLedger(readMigrations(path.join(dir, migrationsDir))),
    );
  }
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "db");
  git(
    "-c",
    "user.name=CI",
    "-c",
    "user.email=ci@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "test migrations",
  );
  const base = git("rev-parse", "HEAD");
  const existing = ledgers();

  const expectDuplicate = (...args: string[]) => {
    const result = cli(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("db/legal/migrations");
    expect(result.stderr).toContain(FIRST);
    expect(result.stderr).toContain(DUPLICATE);
  };
  expectDuplicate();
  expectDuplicate("--base", base);

  // A write would change the first ledger before reaching the duplicate in legal.
  put("main", DISTINCT);
  expectDuplicate("--write");
  expect(ledgers()).toEqual(existing);
});
