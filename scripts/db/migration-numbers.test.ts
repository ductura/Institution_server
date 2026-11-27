// SRV-MIGRACIJE-BROJEVI: pnpm db:new picks a version above the checkout, the
// base and the open PRs, counting open PRs through an injected gh runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { DATABASES, newMigration, nextVersion, openPrVersions } from "./index.ts";
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
