// SRV-MIGRACIJE-BROJEVI: pnpm db:new picks a version above the checkout, the
// base and the open PRs; pnpm db:renumber moves only the branch's own
// migrations that are not above the base, in order, and never a merged one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import {
  DATABASES,
  newMigration,
  nextVersion,
  openPrVersions,
  planMoves,
  renumber,
} from "./index.ts";
import type { Runner } from "./index.ts";

const MAIN = "db/main/migrations";
const LOGS = "db/logs/migrations";
const A = "20261001000000_a.sql";
const B = "20261003000000_b.sql";

/** A fake gh: one open PR #7 whose diff lists `files`. */
const fakeGh =
  (files: string[], calls: string[][] = []): Runner =>
  (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "list") return JSON.stringify([{ number: 7 }]);
    if (args[1] === "diff" && args[2] === "7") return `${files.join("\n")}\n`;
    throw new Error(`unexpected ${args.join(" ")}`);
  };
const noGh: Runner = () => {
  throw new Error("gh: command not found");
};

test("the next version is above every known version, on the 10000 grid", () => {
  assert.equal(nextVersion(["20261220570000", "20261220560000"]), "20261220580000");
  assert.equal(nextVersion(["20261220571234", undefined]), "20261220580000");
  assert.throws(() => nextVersion([]));
});

test("open PR versions come from gh, per directory; without gh it warns and counts none", () => {
  const calls: string[][] = [];
  const gh = fakeGh(
    [`${MAIN}/20261220580000_x.sql`, `${LOGS}/20261220590000_y.sql`, "docs/a.md"],
    calls,
  );
  assert.deepEqual(
    openPrVersions(gh, MAIN, () => {}),
    ["20261220580000"],
  );
  assert.deepEqual(
    openPrVersions(gh, LOGS, () => {}),
    ["20261220590000"],
  );
  assert.deepEqual(calls[0]?.slice(0, 5), [
    "gh",
    "pr",
    "list",
    "--base",
    "migracija/kopija-ductus-backend",
  ]);
  const warnings: string[] = [];
  assert.deepEqual(
    openPrVersions(noGh, MAIN, (line) => warnings.push(line)),
    [],
  );
  assert.match(warnings.join("\n"), /gh failed.*CI still rejects/);
});

test("planMoves moves only added migrations not above the base, keeping their order", () => {
  const moves = planMoves(
    MAIN,
    [A, B],
    [A, B, "20261002000000_c.sql", "20261003000000_d.sql", "20261009000000_e.sql"],
    ["20261005000000"],
  );
  assert.deepEqual(
    moves.map((move) => `${move.from}>${move.to}`),
    ["20261002000000_c.sql>20261005010000_c.sql", "20261003000000_d.sql>20261005020000_d.sql"],
  );
  // An added one between the base and the moved ones moves too, to stay after them.
  assert.deepEqual(
    planMoves(
      MAIN,
      [B],
      [B, "20261002000000_c.sql", "20261004000000_f.sql"],
      ["20261008000000"],
    ).map((move) => move.to),
    ["20261008010000_c.sql", "20261008020000_f.sql"],
  );
  assert.deepEqual(planMoves(MAIN, [A, B], [A, B], []), [], "merged migrations never move");
});

type Repo = {
  dir: string;
  git: (...args: string[]) => string;
  put: (file: string, text: string) => void;
};

function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-numbers-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "ci@example.test");
  git("config", "user.name", "CI");
  git("config", "commit.gpgsign", "false");
  for (const { migrationsDir } of DATABASES)
    mkdirSync(path.join(dir, migrationsDir), { recursive: true });
  const put = (file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  return { dir, git, put };
}

test("db:renumber moves the branch's low migrations, updates references and the ledger, never a merged one", () => {
  const r = repo();
  try {
    const merged = `-- migrate:up\n-- mentions 20261002000000_c.sql on purpose\n-- migrate:down\n`;
    r.put(`${MAIN}/${A}`, merged);
    r.put(`${MAIN}/${B}`, "b\n");
    r.put(`${LOGS}/${A}`, "logs a\n");
    r.put("docs/old.md", "see 20261003000000_b.sql\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "base");
    r.git("branch", "base");
    r.put(`${MAIN}/20261002000000_c.sql`, "c, after 20261001000000_a\n");
    r.put(`${MAIN}/20261009000000_e.sql`, "e\n");
    r.put(`${LOGS}/20261002000000_l.sql`, "logs l\n");
    r.put("db/main/tests/c.sql", "-- tests 20261002000000_c.sql\n");
    r.put("db/logs/tests/l.sql", "-- tests 20261002000000, which logs keeps\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "branch");

    const gh = fakeGh([`${MAIN}/20261005000000_open.sql`]);
    const { moves, edited } = renumber({ cwd: r.dir, gh, base: "base", log: () => {} });
    assert.deepEqual(
      moves.map((move) => `${move.dir}/${move.to}`),
      [`${MAIN}/20261005010000_c.sql`],
      "logs' addition is above the logs base; e is above main's base",
    );
    assert.ok(existsSync(path.join(r.dir, MAIN, "20261005010000_c.sql")));
    assert.ok(!existsSync(path.join(r.dir, MAIN, "20261002000000_c.sql")));
    assert.ok(existsSync(path.join(r.dir, MAIN, "20261009000000_e.sql")));
    assert.ok(existsSync(path.join(r.dir, LOGS, "20261002000000_l.sql")));
    assert.equal(
      readFileSync(path.join(r.dir, "db/main/tests/c.sql"), "utf8"),
      "-- tests 20261005010000_c.sql\n",
    );
    assert.deepEqual(
      edited,
      ["db/main/tests/c.sql"],
      "a bare version another migration keeps stays",
    );
    // Merged migrations and files that only name merged ones are untouched.
    assert.equal(
      r.git("diff", "--name-only", "base", "--", `${MAIN}/${A}`, `${MAIN}/${B}`, "docs"),
      "",
    );
    assert.equal(readFileSync(path.join(r.dir, MAIN, A), "utf8"), merged);
    const ledger = readFileSync(path.join(r.dir, "db/main/migrations.sum"), "utf8");
    assert.match(ledger, /  20261005010000_c\.sql\n/);
    assert.doesNotMatch(ledger, /20261002000000_c/);
    const check = execFileSync(
      process.execPath,
      [path.resolve("scripts/db/migrations-ledger.ts"), "--base", r.git("rev-parse", "base")],
      { cwd: r.dir, encoding: "utf8" },
    );
    assert.match(check, /unchanged/);

    const again = renumber({ cwd: r.dir, gh: noGh, base: "base", log: () => {} });
    assert.deepEqual(again.moves, [], "a second run has nothing to do");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}, 60_000);

test("db:new creates the next migration above the checkout, the base and open PRs, with the ledger", () => {
  const r = repo();
  try {
    r.put(`${MAIN}/${A}`, "a\n");
    r.put(`${LOGS}/${A}`, "logs a\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "base");
    r.git("branch", "base");
    r.put(`${MAIN}/${B}`, "b\n");
    const gh = fakeGh([`${MAIN}/20261004000000_open.sql`]);
    const file = newMigration({ name: "add_thing", db: "main", cwd: r.dir, gh, base: "base" });
    assert.equal(file, `${MAIN}/20261004010000_add_thing.sql`);
    assert.match(
      readFileSync(path.join(r.dir, file), "utf8"),
      /^-- migrate:up\n[\s\S]*\n-- migrate:down\n$/,
    );
    assert.match(
      readFileSync(path.join(r.dir, "db/main/migrations.sum"), "utf8"),
      /20261004010000_add_thing\.sql/,
    );
    assert.equal(
      newMigration({ name: "x", db: "logs", cwd: r.dir, gh: noGh, base: "base" }),
      `${LOGS}/20261001010000_x.sql`,
    );
    assert.throws(() =>
      newMigration({ name: "Bad-Name", db: "main", cwd: r.dir, gh, base: "base" }),
    );
    assert.throws(() => newMigration({ name: "x", db: "nope", cwd: r.dir, gh, base: "base" }));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}, 60_000);
