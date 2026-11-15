// DAN-759, DAN-787: .stack/vs1/state.json names what runs (repository SHAs,
// package versions, build hash) and what `down` may stop (pid and exact command line).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FORBIDDEN_PORTS, type Ports, type StackEnv } from "./config.ts";

export type StackProcess = { pid: number; marker: string };
export type Revision = { sha: string; dirty: boolean };
// The preloader and web slots are not attached yet (SLOTS): null, never a guess.
export type Repos = { server: Revision; preloader: Revision | null; web: Revision | null };
export const PROCESSES = ["oidc", "server"] as const;
export type StackState = {
  env: StackEnv;
  startedAt: string;
  repos: Repos;
  versions: Record<string, string>;
  serverBuildSha256: string;
  ports: Ports;
  processes: Partial<Record<(typeof PROCESSES)[number], StackProcess>>;
  pgdata: string;
};

// The packages whose installed version decides what the stack runs.
const MANIFEST: Readonly<Record<string, string>> = {
  "@ductura/server": "package.json",
  "@ductura/contracts": "packages/contracts/package.json",
  "@ductura/test-fakes": "packages/test-fakes/package.json",
  "oidc-provider": "node_modules/oidc-provider/package.json",
  pg: "node_modules/pg/package.json",
};
export const VERSIONED: readonly string[] = Object.keys(MANIFEST);

/** Installed versions by package name, plus node; a missing manifest is an error. */
export function packageVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = { node: process.version };
  for (const [name, file] of Object.entries(MANIFEST)) {
    const { version } = JSON.parse(readFileSync(join(root, file), "utf8")) as { version?: unknown };
    if (typeof version !== "string") throw new Error(`${name} has no version`);
    versions[name] = version;
  }
  return versions;
}

/** HEAD and whether the work tree differs from it. */
export function repoRevision(root: string): { sha: string; dirty: boolean } {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
}

/** The version of the `postgres` on PATH, e.g. "17.2". */
export function postgresVersion(path: string): string {
  const out = execFileSync("postgres", ["--version"], { encoding: "utf8", env: { PATH: path } });
  const version = /\(PostgreSQL\) (\S+)/u.exec(out)?.[1];
  if (version === undefined) throw new Error("postgres --version names no version");
  return version;
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

/** True when `value` has the ports and processes that `down` reads; 3000-3004 are never ours. */
export function isStackState(value: unknown): value is StackState {
  if (!isObject(value) || !isObject(value.ports) || !isObject(value.processes)) return false;
  const { ports, processes } = value;
  const portsOk = ["postgres", "server", "oidc"].every((name) => {
    const port = ports[name];
    return (
      Number.isInteger(port) &&
      (port as number) > 0 &&
      (port as number) <= 65_535 &&
      !FORBIDDEN_PORTS.includes(port as number)
    );
  });
  const processesOk = PROCESSES.every((name) => {
    const entry = processes[name];
    return (
      entry === undefined ||
      (isObject(entry) && Number.isInteger(entry.pid) && typeof entry.marker === "string")
    );
  });
  // Exactly the known keys: down and status may only ever touch these ports.
  const keysOk =
    Object.keys(ports).sort().join() === "oidc,postgres,server" &&
    Object.keys(processes).every((name) => (PROCESSES as readonly string[]).includes(name));
  return keysOk && portsOk && processesOk;
}

/** The state; null when there is none, "unreadable" when the file is not a whole state. */
export function readState(file: string): StackState | null | "unreadable" {
  let text: string;
  try {
    // Only a regular file of bounded size: a FIFO would block, a link may lead out.
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 65_536) return "unreadable";
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (Reflect.get(error as object, "code") === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isStackState(parsed) ? parsed : "unreadable";
  } catch {
    return "unreadable";
  }
}
