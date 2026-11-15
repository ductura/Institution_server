// DAN-759: the state file of the VS-1 stack (.stack/vs1/state.json). It names
// what runs (repository SHA, package versions, build hash) and what `down`
// may stop (process ids with the command line each must still have).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Ports, StackEnv } from "./config.ts";

export type StackProcess = { pid: number; marker: string };
export type StackState = {
  env: StackEnv;
  startedAt: string;
  repo: { sha: string; dirty: boolean };
  versions: Record<string, string>;
  serverBuildSha256: string;
  ports: Ports;
  processes: { server?: StackProcess };
  pgdata: string;
};

// The packages whose installed version decides what the stack runs.
export const VERSIONED = [
  "@ductura/server",
  "@ductura/contracts",
  "@ductura/test-fakes",
  "oidc-provider",
  "pg",
];
const MANIFEST: Readonly<Record<string, string>> = {
  "@ductura/server": "package.json",
  "@ductura/contracts": "packages/contracts/package.json",
  "@ductura/test-fakes": "packages/test-fakes/package.json",
  "oidc-provider": "node_modules/oidc-provider/package.json",
  pg: "node_modules/pg/package.json",
};

/** Installed versions by package name, plus node; a missing manifest is an error. */
export function packageVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = { node: process.version };
  for (const name of VERSIONED) {
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST[name] as string), "utf8")) as {
      version?: unknown;
    };
    if (typeof manifest.version !== "string") throw new Error(`${name} has no version`);
    versions[name] = manifest.version;
  }
  return versions;
}

/** HEAD and whether the work tree differs from it. */
export function repoRevision(root: string): { sha: string; dirty: boolean } {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
}

export const sha256File = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function writeState(file: string, state: StackState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** The state, or null when the stack was never started or is down. */
export function readState(file: string): StackState | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StackState;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
}
