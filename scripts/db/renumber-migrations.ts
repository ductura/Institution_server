// SRV-MIGRACIJE-BROJEVI: `pnpm db:renumber [--base <ref>]` moves the migrations
// this branch adds whose version is not above the base's greatest version to
// the next free versions above the base and the open PRs, in their order, then
// rewrites the ledgers and the references to the old versions in the repo.
// A migration that exists at the base is merged and never touched.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DATABASES } from "./databases.ts";
import { maxVersion, versionOf } from "./migrations-ledger.ts";
import {
  BASE_REF,
  nextVersion,
  openPrVersions,
  runIn,
  STEP,
  writeLedgers,
} from "./new-migration.ts";
import type { Runner } from "./new-migration.ts";

export type Move = { dir: string; from: string; to: string };

/**
 * The moves for one directory. Added migrations are those not in `baseNames`;
 * they move when not above the base, and every later one that would otherwise
 * sort before a moved one moves with it, so the branch keeps its order.
 */
export function planMoves(
  dir: string,
  baseNames: string[],
  current: string[],
  openVersions: string[],
): Move[] {
  const base = new Set(baseNames);
  const baseMax = maxVersion(baseNames);
  if (baseMax === undefined) return [];
  let cursor = Number(nextVersion([baseMax, ...openVersions]));
  const moves: Move[] = [];
  for (const name of current.filter((file) => !base.has(file)).sort()) {
    const version = versionOf(name);
    if (version === undefined) continue;
    if (version <= baseMax || (moves.length > 0 && Number(version) < cursor)) {
      const to = `${String(cursor).padStart(14, "0")}${name.slice(14)}`;
      moves.push({ dir, from: name, to });
      cursor += STEP;
    }
  }
  return moves;
}

export type RenumberOptions = {
  cwd: string;
  gh: Runner;
  base?: string;
  log?: (line: string) => void;
};

/** Applies the moves of every database; returns them and the files whose text changed. */
export function renumber({ cwd, gh, base = BASE_REF, log = console.log }: RenumberOptions): {
  moves: Move[];
  edited: string[];
} {
  const git = runIn(cwd);
  git("git", ["rev-parse", "--verify", `${base}^{commit}`]);
  const moves: Move[] = [];
  const merged = new Set<string>();
  const current: string[] = [];
  for (const { migrationsDir: dir } of DATABASES) {
    const baseNames = git("git", ["ls-tree", "--name-only", `${base}^{commit}`, "--", `${dir}/`])
      .split("\n")
      .filter(Boolean)
      .map((file) => path.posix.basename(file));
    for (const name of baseNames) merged.add(`${dir}/${name}`);
    const names = readdirSync(path.join(cwd, dir));
    current.push(...names.map((name) => `${dir}/${name}`));
    moves.push(...planMoves(dir, baseNames, names, openPrVersions(gh, dir)));
  }
  if (moves.length === 0) {
    log("nothing to renumber");
    return { moves, edited: [] };
  }
  for (const move of [...moves].reverse()) {
    if (merged.has(`${move.dir}/${move.from}`)) throw new Error(`${move.from} is merged`);
    git("git", ["mv", "--", `${move.dir}/${move.from}`, `${move.dir}/${move.to}`]);
    log(`${move.dir}: ${move.from} -> ${move.to}`);
  }
  // References by file stem, and by bare version where that version names no
  // merged migration and only one move; an ambiguous key is left alone.
  const pairs = moves.flatMap((move) => [
    [move.from.replace(/\.sql$/, ""), move.to.replace(/\.sql$/, "")],
    [move.from.slice(0, 14), move.to.slice(0, 14)],
  ]);
  const count = (key: string): number => pairs.filter(([old]) => old === key).length;
  const moved = new Set(moves.map((move) => `${move.dir}/${move.from}`));
  const kept = new Set(
    [...merged, ...current]
      .filter((file) => !moved.has(file))
      .map((file) => versionOf(path.posix.basename(file))),
  );
  const renamed = new Map(
    pairs.filter(([old]) => count(old as string) === 1 && !kept.has(old)) as [string, string][],
  );
  if (renamed.size === 0) {
    writeLedgers(cwd);
    return { moves, edited: [] };
  }
  const keys = [...renamed.keys()].sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(`(?<!\\d)(${keys})(?!\\w)`, "g");
  const ledgers = new Set(DATABASES.map((entry) => entry.ledger));
  const grep = ["grep", "-l", "-I", "-E", keys];
  const edited: string[] = [];
  let found = "";
  try {
    found = git("git", grep);
  } catch {
    // git grep exits 1 when nothing matches
  }
  for (const file of found.split("\n").filter(Boolean)) {
    // Merged migrations and the ledgers are never edited here.
    if (merged.has(file) || ledgers.has(file)) continue;
    const text = readFileSync(path.join(cwd, file), "utf8");
    const next = text.replace(pattern, (old) => renamed.get(old) as string);
    if (next === text) continue;
    writeFileSync(path.join(cwd, file), next);
    edited.push(file);
    log(`updated references in ${file}`);
  }
  writeLedgers(cwd);
  return { moves, edited };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!(args.length === 0 || (args[0] === "--base" && args.length === 2))) {
      throw new Error("usage: pnpm db:renumber [--base <ref>]");
    }
    const cwd = process.cwd();
    renumber({ cwd, gh: runIn(cwd), base: args[1] ?? BASE_REF });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
