// DAN-759: processes of the VS-1 stack. Each starts detached in its own process
// group, logging to a file, and is stopped only through the recorded id and only
// while its command line is still exactly the recorded one, so a reused id or
// another stack's process is never signalled.
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { connect } from "node:net";

export type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
type Start = { cwd: string; env: Record<string, string>; log: string };

/** Starts `command` detached; resolves to its pid once it was spawned. */
export function startDetached(
  command: string,
  args: readonly string[],
  { cwd, env, log }: Start,
): Promise<number> {
  const out = openSync(log, "a", 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve((child.unref(), child.pid as number)));
  });
}

/** Polls `url` until it answers 200; false after `timeoutMs`. */
export async function waitHealthy(
  url: string,
  timeoutMs: number,
  get = fetch,
  wait = sleep,
): Promise<boolean> {
  for (let left = timeoutMs; left > 0; left -= 250) {
    const ok = await get(url, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ok) return true;
    await wait(250);
  }
  return false;
}

/** True when nothing accepts connections on 127.0.0.1:`port`. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve((socket.destroy(), false)));
    socket.once("error", () => resolve(true));
  });
}

/** The whole command line of `pid` (ps -ww, COLUMNS ignored), or null when it does not exist. */
export function commandLine(pid: number): string | null {
  const options = { encoding: "utf8" as const, env: { PATH: process.env.PATH ?? "" } };
  try {
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], options).trim();
  } catch {
    return null;
  }
}

// A group that exits between the check and the signal is already stopped.
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "ESRCH") throw error;
  }
}

export type StopDeps = {
  command?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: Wait;
};

/**
 * Stops the process group of `pid` while its command line is exactly `marker`:
 * SIGTERM, then SIGKILL after `graceMs`, each signal only after a fresh check.
 */
export async function stopProcess(
  pid: number,
  marker: string,
  graceMs: number,
  { command = commandLine, kill = signalGroup, wait = sleep }: StopDeps = {},
): Promise<"stopped" | "gone" | "foreign"> {
  if (!Number.isInteger(pid) || pid <= 1) return "foreign";
  const line = command(pid);
  if (line === null) return "gone";
  if (line !== marker) return "foreign";
  // An exited child not yet reaped shows as <defunct>, not as the marker.
  const alive = (): boolean => command(pid) === marker;
  kill(pid, "SIGTERM");
  for (let left = graceMs; left > 0 && alive(); left -= 100) await wait(100);
  // Checked again: the id may have been freed and reused during the last wait.
  if (!alive()) return "stopped";
  kill(pid, "SIGKILL");
  for (let tries = 0; tries < 20 && alive(); tries += 1) await wait(100);
  return "stopped";
}
