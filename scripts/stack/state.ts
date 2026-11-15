// DAN-759: the state file of the VS-1 stack (.stack/vs1/state.json). It names
// what runs (repository SHA, package versions, build hash) and what `down`
// may stop (process ids with the command line each must still have).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Writes the whole file or nothing (temporary file, then rename). */
export function writeState(file: string, state: StackState): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPort = (value: unknown): boolean =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65_535;

/** True when `value` has the parts `down` and `status` read: ports and processes. */
export function isStackState(value: unknown): value is StackState {
  if (!isObject(value) || !isObject(value.ports) || !isObject(value.processes)) return false;
  const { ports, processes } = value;
  if (!["postgres", "server", "oidc"].every((name) => isPort(ports[name]))) return false;
  const server = processes.server;
  return (
    server === undefined ||
    (isObject(server) && Number.isInteger(server.pid) && typeof server.marker === "string")
  );
}

/** The state; null when there is none, "unreadable" when the file is not a whole state. */
export function readState(file: string): StackState | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isStackState(parsed) ? parsed : "unreadable";
  } catch {
    return "unreadable";
  }
}
