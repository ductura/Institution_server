// DAN-759: one `up` at a time. The lock is a file made with O_EXCL ("wx"), so
// only one process can create it. A lock left by an `up` that was killed or cut
// off by a restart (its pid no longer runs the script) is taken over only by
// the holder of a second exclusive lock, the takeover directory (mkdir is
// atomic), so two processes never both replace the same stale lock.
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";

export type OwnerRuns = (pid: number) => boolean;

function tryLock(file: string): boolean {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (Reflect.get(error as object, "code") === "EEXIST") return false;
    throw error;
  }
}

/** The pid in the lock file, or null when there is no lock. */
function owner(file: string): number | null {
  try {
    return Number(readFileSync(file, "utf8"));
  } catch (error) {
    if (Reflect.get(error as object, "code") === "ENOENT") return null;
    throw error;
  }
}

/**
 * Removes the lock if its owner no longer runs, holding the takeover lock;
 * false when another process holds the takeover. Throws when the owner runs.
 */
export function clearStaleLock(file: string, ownerRuns: OwnerRuns): boolean {
  const takeover = `${file}.takeover`;
  try {
    mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if (Reflect.get(error as object, "code") === "EEXIST") return false;
    throw error;
  }
  try {
    const pid = owner(file);
    if (pid !== null && ownerRuns(pid)) throw new Error(`another up (pid ${pid}) is running`);
    rmSync(file, { force: true });
    return true;
  } finally {
    rmdirSync(takeover);
  }
}

/** Takes the lock for this process or throws. */
export function takeLock(file: string, ownerRuns: OwnerRuns): void {
  if (tryLock(file)) return;
  if (!clearStaleLock(file, ownerRuns)) {
    throw new Error(`another up is taking over the lock (${file}.takeover)`);
  }
  if (!tryLock(file)) throw new Error("another up took the lock");
}
