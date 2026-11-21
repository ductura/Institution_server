// D-91 (1), DAN-71: db/main/migrations.sum holds the SHA-256 of every
// migration, and a migration that exists in the accepted base may never change
// or disappear, even when the ledger changes with it. Ported from Ductus
// scripts/engineering/migrations-ledger.test.mjs at d52a92c3 (S-0.13,
// DAN-726): same assertions, node:test replaced by vitest, paths adapted.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import {
  checkBase,
  checkLedger,
  checkVersions,
  DATABASES,
  DIR,
  LEDGER,
  readMigrations,
  renderLedger,
} from "./index.ts";

const script = path.resolve("scripts/db/migrations-ledger.ts");
const A = "20261001000000_a.sql";
const B = "20261002000000_b.sql";
const files = (entries: Record<string, string>): Map<string, Buffer> =>
  new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));
// sha256("a"); used with one space instead of two to make a malformed line.
const SHA_A = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";

test("the ledger lists every migration by name, sorted, with its SHA-256", () => {
  const text = renderLedger(files({ [B]: "b", [A]: "a" }));
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] as string, new RegExp(`^[0-9a-f]{64}  ${A}$`));
  assert.match(lines[1] as string, new RegExp(`^[0-9a-f]{64}  ${B}$`));
  assert.equal(
    (lines[0] as string).slice(0, 64),
    "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  );
  assert.ok(text.endsWith("\n"));
});

test("a ledger that matches the migrations passes", () => {
  const migrations = files({ [A]: "a", [B]: "b" });
  assert.deepEqual(checkLedger(migrations, renderLedger(migrations)), []);
});

test("a new migration without a ledger line, a stale line or a changed hash fails", () => {
  const migrations = files({ [A]: "a", [B]: "b" });
  const onlyA = renderLedger(files({ [A]: "a" }));
  assert.match(
    checkLedger(migrations, onlyA).join("\n"),
    new RegExp(`${B}.*not in db/main/migrations.sum`),
  );
  assert.match(
    checkLedger(files({ [A]: "a" }), renderLedger(migrations)).join("\n"),
    new RegExp(`${B}.*no such migration`),
  );
  assert.match(checkLedger(files({ [A]: "a2" }), onlyA).join("\n"), new RegExp(`${A}.*hash`));
  assert.match(checkLedger(files({ [A]: "a" }), `${SHA_A} ${A}\n`).join("\n"), /line 1/);
  assert.match(checkLedger(files({ [A]: "a" }), "").join("\n"), /not in db\/main\/migrations.sum/);
  // A missing ledger file reads as null and fails, never as "nothing to check".
  assert.ok(checkLedger(files({ [A]: "a" }), null).length > 0);
});

test("a base migration that changed, disappeared or was renamed fails, even with an updated ledger", () => {
  const base = files({ [A]: "a" });
  assert.deepEqual(checkBase(base, files({ [A]: "a", [B]: "b" })), []);
  assert.match(
    checkBase(base, files({ [A]: "a changed" })).join("\n"),
    new RegExp(`${A}.*changed`),
  );
  assert.match(checkBase(base, files({ [B]: "b" })).join("\n"), new RegExp(`${A}.*removed`));
  assert.match(
    checkBase(base, files({ ["20261001000000_renamed.sql"]: "a" })).join("\n"),
    new RegExp(`${A}.*removed`),
  );
});

test("the committed ledger matches db/main/migrations of this checkout", () => {
  const migrations = readMigrations(DIR);
  assert.ok(migrations.size > 0);
  assert.deepEqual(checkLedger(migrations, readFileSync(LEDGER, "utf8")), []);
});

// S-0.13: the ledger is the one carried over from Ductus, so a fresh run over
// the same migrations must write exactly the committed file, byte for byte.
test("a ledger computed afresh from db/main/migrations equals the committed file byte for byte", () => {
  const committed = readFileSync(LEDGER);
  const fresh = Buffer.from(renderLedger(readMigrations(DIR)), "utf8");
  assert.ok(committed.length > 0);
  assert.ok(fresh.equals(committed), "pnpm db:sum would change db/main/migrations.sum");
});

// QA FAIL c.6881958114 (cxcqs17), finding 1: the ledger hashes raw bytes, so a
// Windows checkout with core.autocrlf=true must still get LF. .gitattributes
// fixes LF for the migrations and the ledger (as Ductus .gitattributes does).
test("git checks out every migration and the ledger with LF on every platform", () => {
  const paths = [...readMigrations(DIR).keys()].map((name) => `${DIR}/${name}`);
  const output = execFileSync("git", ["check-attr", "text", "eol", "--", ...paths, LEDGER], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const wrong = output
    .trimEnd()
    .split("\n")
    .filter((line) => !/: text: set$/.test(line) && !/: eol: lf$/.test(line));
  assert.deepEqual(wrong, []);
  assert.equal(output.trimEnd().split("\n").length, (paths.length + 1) * 2);
});

test("no migration and not the ledger contains a carriage return in this checkout", () => {
  const withCr = [...readMigrations(DIR)]
    .filter(([, bytes]) => bytes.includes(0x0d))
    .map(([name]) => `${DIR}/${name}`);
  if (readFileSync(LEDGER).includes(0x0d)) withCr.push(LEDGER);
  assert.deepEqual(withCr, [], "CRLF checkout: the ledger would not match the files");
});

type Repo = {
  dir: string;
  put: (name: string, text: string) => void;
  cli: (...args: string[]) => ReturnType<typeof spawnSync>;
  commit: () => string;
};

// The CLI against a throwaway git repository, the way CI runs it.
function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-ledger-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "ci@example.test");
  git("config", "user.name", "CI");
  git("config", "commit.gpgsign", "false");
  // S-1F-c (DAN-779): every database of scripts/db/databases.ts has its directory.
  for (const { migrationsDir } of DATABASES)
    mkdirSync(path.join(dir, migrationsDir), { recursive: true });
  const put = (name: string, text: string): void =>
    writeFileSync(path.join(dir, "db", "main", "migrations", name), text);
  const cli = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
  const commit = (): string => {
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    return git("rev-parse", "HEAD");
  };
  return { dir, put, cli, commit };
}

test("CLI: --write records the ledger, a later addition passes, an edit of a base migration fails", () => {
  const r = repo();
  try {
    r.put(A, "create table a ();\n");
    assert.equal(r.cli("--write").status, 0);
    const base = r.commit();
    assert.equal(r.cli("--base", base).status, 0);

    r.put(B, "create table b ();\n");
    assert.equal(r.cli("--base", base).status, 1, "a new migration without a ledger line fails");
    assert.equal(r.cli("--write").status, 0);
    assert.equal(r.cli("--base", base).status, 0);

    r.put(A, "create table a (x int);\n");
    assert.equal(r.cli("--write").status, 0);
    const edited = r.cli("--base", base);
    assert.equal(edited.status, 1, "an edited base migration fails even with the ledger rewritten");
    assert.match(String(edited.stderr), /changed/);
    assert.equal(r.cli().status, 0, "without a base only the ledger is checked");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CLI: a deleted base migration, an unknown base and a directory in db/main/migrations fail closed", () => {
  const r = repo();
  try {
    r.put(A, "a\n");
    r.put(B, "b\n");
    r.cli("--write");
    const base = r.commit();
    rmSync(path.join(r.dir, "db", "main", "migrations", B));
    r.cli("--write");
    assert.equal(r.cli("--base", base).status, 1);
    r.put(B, "b\n");
    r.cli("--write");
    assert.equal(r.cli("--base", "f".repeat(40)).status, 1);
    assert.equal(r.cli("--base", "not-a-sha").status, 1);
    mkdirSync(path.join(r.dir, "db", "main", "migrations", "nested"));
    assert.equal(r.cli().status, 1);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a version used by two migrations of one database fails and names both files", () => {
  const dup = "20261001000000_other.sql";
  const errors = checkVersions(files({ [A]: "a", [dup]: "x", [B]: "b" }), "db/main/migrations");
  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, new RegExp(`${A} and ${dup}`));
  assert.deepEqual(checkVersions(files({ [A]: "a", [B]: "b" })), []);
});

test("CLI: a duplicate version fails the check, --base and --write, and --write keeps the ledger", () => {
  const r = repo();
  try {
    r.put(A, "a\n");
    assert.equal(r.cli("--write").status, 0);
    const base = r.commit();
    const ledger = path.join(r.dir, "db", "main", "migrations.sum");
    const before = readFileSync(ledger, "utf8");
    r.put("20261001000000_dup.sql", "d\n");
    for (const args of [[], ["--base", base], ["--write"]]) {
      const result = r.cli(...args);
      assert.equal(result.status, 1, args.join(" ") || "check");
      assert.match(String(result.stderr), new RegExp(`${A} and 20261001000000_dup\\.sql`));
    }
    assert.equal(readFileSync(ledger, "utf8"), before, "--write wrote nothing");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CI checks the ledger against the PR base and the previous main head", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const start = ci.indexOf("\n  checks:\n");
  assert.ok(start > 0);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  const checks = ci.slice(start, next > 0 ? start + 1 + next : undefined);
  assert.match(checks, /- name: Knjiga migracija \(D-91\)\n/);
  assert.match(checks, /PR_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(checks, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(checks, /node scripts\/db\/migrations-ledger\.ts --base "\$base"/);
});

// S-1F-c (DAN-779): the logs database has its own ledger, held to the same rules.
test("CLI: the logs ledger is checked too, and a migrations directory off the list fails", () => {
  const r = repo();
  const logs = (name: string, text: string): void =>
    writeFileSync(path.join(r.dir, "db", "logs", "migrations", name), text);
  try {
    r.put(A, "a\n");
    logs(A, "logs a\n");
    assert.equal(r.cli("--write").status, 0);
    assert.match(
      readFileSync(path.join(r.dir, "db", "logs", "migrations.sum"), "utf8"),
      new RegExp(`^[0-9a-f]{64}  ${A}\n$`),
    );
    const base = r.commit();
    assert.equal(r.cli("--base", base).status, 0);

    logs(B, "logs b\n");
    const unlisted = r.cli("--base", base);
    assert.equal(unlisted.status, 1, "a logs migration without a ledger line fails");
    assert.match(String(unlisted.stderr), /not in db\/logs\/migrations\.sum/);
    rmSync(path.join(r.dir, "db", "logs", "migrations", B));

    logs(A, "logs a changed\n");
    r.cli("--write");
    const edited = r.cli("--base", base);
    assert.equal(edited.status, 1, "an edited logs base migration fails with the ledger rewritten");
    assert.match(String(edited.stderr), /changed/);
    logs(A, "logs a\n");
    r.cli("--write");
    assert.equal(r.cli("--base", base).status, 0);

    mkdirSync(path.join(r.dir, "db", "other", "migrations"), { recursive: true });
    const other = r.cli();
    assert.equal(other.status, 1);
    assert.match(String(other.stderr), /db\/other\/migrations is not a database/);
    assert.equal(r.cli("--write").status, 1, "--write does not cover an unlisted directory");
    rmSync(path.join(r.dir, "db", "other"), { recursive: true });

    rmSync(path.join(r.dir, "db", "logs", "migrations"), { recursive: true });
    assert.equal(r.cli().status, 1, "a listed database without its directory fails");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("every committed ledger matches its directory and stays LF", () => {
  for (const { migrationsDir, ledger } of DATABASES) {
    const migrations = readMigrations(migrationsDir);
    assert.ok(migrations.size > 0, `${migrationsDir} has migrations`);
    assert.deepEqual(checkLedger(migrations, readFileSync(ledger, "utf8"), ledger), []);
    const paths = [...migrations.keys()].map((name) => `${migrationsDir}/${name}`);
    const output = execFileSync("git", ["check-attr", "eol", "--", ...paths, ledger], {
      encoding: "utf8",
    });
    for (const line of output.trimEnd().split("\n")) assert.match(line, /: eol: lf$/);
  }
});
