// D-91 (1), DAN-71: db/main/migrations.sum holds the SHA-256 of every migration
// in db/main/migrations. CI fails when the ledger does not match the files, and,
// given the accepted base commit, when a migration of that base changed or
// disappeared: migrations are append-only, and rewriting the ledger with the
// edit does not help, because the base files are compared byte for byte.
// Ported from Ductus scripts/engineering/migrations-ledger.mjs at d52a92c3
// (S-0.13, DAN-726); only the paths and the types changed. S-1F-c (DAN-779):
// every database of scripts/db/databases.ts has its own directory and ledger,
// all are checked, and a db/<name>/migrations directory that is not on that
// list fails, so no migrations can sit outside a ledger.
//
//   node scripts/db/migrations-ledger.ts            check every ledger
//   node scripts/db/migrations-ledger.ts --base SHA also check SHA
//   node scripts/db/migrations-ledger.ts --write    rewrite every ledger
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DATABASES } from "./databases.ts";

export const DIR = "db/main/migrations";
export const LEDGER = "db/main/migrations.sum";
const LINE = /^([0-9a-f]{64}) {2}(\S+)$/;

const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

/** name -> bytes of every migration; anything but a plain file is an error. */
export function readMigrations(dir: string): Map<string, Buffer> {
  const migrations = new Map<string, Buffer>();
  for (const name of readdirSync(dir).sort()) {
    if (!lstatSync(path.join(dir, name)).isFile()) {
      throw new Error(`${dir}/${name} is not a plain file`);
    }
    migrations.set(name, readFileSync(path.join(dir, name)));
  }
  return migrations;
}

export function renderLedger(migrations: Map<string, Buffer>): string {
  return [...migrations.keys()]
    .sort()
    .map((name) => `${sha256(migrations.get(name) as Buffer)}  ${name}\n`)
    .join("");
}

/** Errors between the files and the ledger text (null: no ledger file). */
export function checkLedger(
  migrations: Map<string, Buffer>,
  ledgerText: string | null,
  ledger: string = LEDGER,
): string[] {
  const errors: string[] = [];
  const listed = new Map<string, string>();
  (ledgerText ?? "").split("\n").forEach((line, index) => {
    if (line === "") return;
    const match = LINE.exec(line);
    if (!match) errors.push(`${ledger} line ${index + 1} is not "<sha256>  <file>"`);
    else if (listed.has(match[2] as string))
      errors.push(`${match[2]} is listed twice in ${ledger}`);
    else listed.set(match[2] as string, match[1] as string);
  });
  for (const [name, bytes] of migrations) {
    if (!listed.has(name)) errors.push(`${name} is not in ${ledger}; run pnpm db:sum`);
    else if (listed.get(name) !== sha256(bytes)) {
      errors.push(`${name}: hash in ${ledger} does not match the file`);
    }
  }
  for (const name of listed.keys()) {
    if (!migrations.has(name))
      errors.push(`${name} is in ${ledger} but there is no such migration`);
  }
  if (ledgerText == null) errors.push(`${ledger} is missing`);
  return errors;
}

/** Errors for base migrations that are not byte-identical in the checkout. */
export function checkBase(base: Map<string, Buffer>, migrations: Map<string, Buffer>): string[] {
  const errors: string[] = [];
  for (const [name, bytes] of base) {
    if (!migrations.has(name)) errors.push(`${name} exists in the base and was removed or renamed`);
    else if (!(migrations.get(name) as Buffer).equals(bytes)) {
      errors.push(`${name} exists in the base and was changed`);
    }
  }
  return errors;
}

/** The migrations of a commit, read from git objects, never from the checkout. */
export function readBase(sha: string, dir: string = DIR): Map<string, Buffer> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--base needs a full commit SHA, got "${sha}"`);
  const git = (args: string[]): Buffer =>
    execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
  const base = new Map<string, Buffer>();
  for (const entry of git(["ls-tree", "-z", `${sha}^{commit}`, `${dir}/`])
    .toString("utf8")
    .split("\0")) {
    if (entry === "") continue;
    const [meta = "", file = ""] = entry.split("\t");
    const [mode, type, object = ""] = meta.split(" ");
    if (type !== "blob" || mode !== "100644")
      throw new Error(`${file} in the base is not a plain file`);
    base.set(path.posix.basename(file), git(["cat-file", "blob", object]));
  }
  return base;
}

/** db/<name>/migrations directories under `root` that no entry of DATABASES names. */
export function unlistedMigrationDirs(root = "db"): string[] {
  const listed = new Set(DATABASES.map((entry) => entry.migrationsDir));
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => `${root}/${name}/migrations`)
    .filter((dir) => existsSync(dir) && !listed.has(dir))
    .sort();
}

function readLedger(ledger: string): string | null {
  try {
    return readFileSync(ledger, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function main(argv: string[]): number {
  const write = argv[0] === "--write" && argv.length === 1;
  if (!write && !(argv.length === 0 || (argv[0] === "--base" && argv.length === 2))) {
    throw new Error("usage: migrations-ledger.ts [--write | --base <sha>]");
  }
  const errors = unlistedMigrationDirs().map(
    (dir) => `${dir} is not a database of scripts/db/databases.ts, so no ledger covers it`,
  );
  const summaries: string[] = [];
  for (const { migrationsDir, ledger } of DATABASES) {
    // A listed database without its directory is an error, never "nothing to check".
    const migrations = readMigrations(migrationsDir);
    if (write) {
      writeFileSync(ledger, renderLedger(migrations));
      console.log(`${ledger}: ${migrations.size} migrations`);
      continue;
    }
    errors.push(...checkLedger(migrations, readLedger(ledger), ledger));
    if (argv[0] === "--base") {
      errors.push(...checkBase(readBase(argv[1] as string, migrationsDir), migrations));
    }
    summaries.push(`${ledger}: ${migrations.size} migrations match`);
  }
  for (const error of errors) console.error(error);
  if (errors.length > 0) return 1;
  if (write) return 0;
  for (const summary of summaries) console.log(summary);
  if (argv[0] === "--base") console.log(`base ${(argv[1] as string).slice(0, 12)} unchanged`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
