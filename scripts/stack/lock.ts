// DAN-759: one `up` at a time. The lock is a file made with O_EXCL ("wx"), so
// only one process can create it; it records the owner's pid and its whole
// command line, so a live owner is recognised however it was started (pnpm,
// a relative or absolute path). A lock whose owner no longer runs that command
// (killed, or cut off by a restart) is taken over only by the holder of a second
// exclusive lock, the takeover directory (mkdir is atomic), so two processes
// never both replace the same stale lock.
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";

import { commandLine } from "./processes.ts";

/** Whether `pid` still runs the command line `line` the lock recorded. */
export type OwnerRuns = (pid: number, line: string) => boolean;

export const sameProcess: OwnerRuns = (pid, line) =>
  Number.isInteger(pid) && pid > 1 && line !== "" && commandLine(pid) === line;

function tryLock(file: string): boolean {
  const identity = `${process.pid}\n${commandLine(process.pid) ?? ""}\n`;
  try {
    writeFileSync(file, identity, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (Reflect.get(error as object, "code") === "EEXIST") return false;
    throw error;
  }
}

/** The pid and command line in the lock file, or null when there is no lock. */
function owner(file: string): { pid: number; line: string } | null {
  try {
    const [pid = "", line = ""] = readFileSync(file, "utf8").split("\n");
    return { pid: Number(pid), line };
  } catch (error) {
    if (Reflect.get(error as object, "code") === "ENOENT") return null;
    throw error;
  }
}

/**
 * Removes the lock if its owner no longer runs, holding the takeover lock;
 * false when another process holds the takeover. Throws when the owner runs.
 */
export function clearStaleLock(file: string, ownerRuns: OwnerRuns = sameProcess): boolean {
  const takeover = `${file}.takeover`;
  try {
    mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if (Reflect.get(error as object, "code") === "EEXIST") return false;
    throw error;
  }
  try {
    const found = owner(file);
    if (found !== null && ownerRuns(found.pid, found.line)) {
      throw new Error(`another up (pid ${found.pid}) is running`);
    }
    rmSync(file, { force: true });
    return true;
  } finally {
    rmdirSync(takeover);
  }
}

/** Takes the lock for this process or throws. */
export function takeLock(file: string, ownerRuns: OwnerRuns = sameProcess): void {
  if (tryLock(file)) return;
  if (!clearStaleLock(file, ownerRuns)) {
    throw new Error(`another up is taking over the lock (${file}.takeover)`);
  }
  if (!tryLock(file)) throw new Error("another up took the lock");
}
