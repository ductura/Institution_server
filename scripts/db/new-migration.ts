// SRV-MIGRACIJE-BROJEVI: `pnpm db:new <name> [--db main|logs|legal]` creates
// the next migration of a database. Versions are future-dated sequence numbers
// on a 10000 grid, so the clock cannot pick them: the next one is above the
// greatest version in the checkout, on the base branch and in every open PR
// against it. gh missing or failing only warns; the ordering check of
// migrations-ledger.ts --base in CI still holds.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { databaseNamed } from "./databases.ts";
import { versionOf } from "./migrations-ledger.ts";

export const BASE_BRANCH = "migracija/kopija-ductus-backend";
export const BASE_REF = `origin/${BASE_BRANCH}`;
export const STEP = 10_000;

/** Runs a command and returns its stdout; throws when it fails. */
export type Runner = (command: string, args: string[]) => string;

export const runIn =
  (cwd: string): Runner =>
  (command, args) =>
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

/** The first version on the grid above every one of `versions`. */
export function nextVersion(versions: Iterable<string | undefined>): string {
  let max = 0;
  for (const version of versions) if (version !== undefined) max = Math.max(max, Number(version));
  if (max === 0) throw new Error("no migration version to count from");
  return String((Math.floor(max / STEP) + 1) * STEP).padStart(14, "0");
}

/** Versions in `dir` at `ref`, read from git objects; [] with a warning when unreadable. */
export function refVersions(git: Runner, ref: string, dir: string, warn = console.warn): string[] {
  try {
    return git("git", ["ls-tree", "--name-only", `${ref}^{commit}`, "--", `${dir}/`])
      .split("\n")
      .map((file) => versionOf(path.posix.basename(file.trim())))
      .filter((version): version is string => version !== undefined);
  } catch {
    warn(`warning: cannot read ${ref}; run git fetch origin ${BASE_BRANCH}`);
    return [];
  }
}

/** Versions of migrations in `dir` that open PRs against the base add or touch. */
export function openPrVersions(gh: Runner, dir: string, warn = console.warn): string[] {
  try {
    const prs = JSON.parse(
      gh("gh", [
        "pr",
        "list",
        "--base",
        BASE_BRANCH,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number",
      ]),
    ) as { number: number }[];
    const versions: string[] = [];
    for (const { number } of prs) {
      for (const file of gh("gh", ["pr", "diff", String(number), "--name-only"]).split("\n")) {
        const version = versionOf(path.posix.basename(file.trim()));
        if (path.posix.dirname(file.trim()) === dir && version !== undefined)
          versions.push(version);
      }
    }
    return versions;
  } catch (error) {
    warn(
      `warning: gh failed (${(error as Error).message.split("\n")[0]}); open PRs are not counted, ` +
        "CI still rejects a version that is not above the base",
    );
    return [];
  }
}

export type NewOptions = { name: string; db: string; cwd: string; gh: Runner; base?: string };

/** Creates the migration file, rewrites the ledgers and returns the file's path. */
export function newMigration({ name, db, cwd, gh, base = BASE_REF }: NewOptions): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`name "${name}" must match [a-z0-9_]+`);
  const { migrationsDir } = databaseNamed(db);
  const local = existsSync(path.join(cwd, migrationsDir))
    ? readdirSync(path.join(cwd, migrationsDir)).map(versionOf)
    : [];
  const version = nextVersion([
    ...local,
    ...refVersions(runIn(cwd), base, migrationsDir),
    ...openPrVersions(gh, migrationsDir),
  ]);
  const file = `${migrationsDir}/${version}_${name}.sql`;
  writeFileSync(
    path.join(cwd, file),
    `-- migrate:up\n-- ${name}: what changes and why.\n\n-- migrate:down\n`,
    { flag: "wx" },
  );
  writeLedgers(cwd);
  return file;
}

/** `pnpm db:sum` in `cwd`. */
export function writeLedgers(cwd: string): void {
  const ledger = fileURLToPath(new URL("./migrations-ledger.ts", import.meta.url));
  execFileSync(process.execPath, [ledger, "--write"], { cwd, stdio: "inherit" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const at = args.indexOf("--db");
    const db = at >= 0 ? (args.splice(at, 2)[1] ?? "") : "main";
    if (args.length !== 1) throw new Error("usage: pnpm db:new <name> [--db main|logs|legal]");
    const cwd = process.cwd();
    console.log(`created ${newMigration({ name: args[0] as string, db, cwd, gh: runIn(cwd) })}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
