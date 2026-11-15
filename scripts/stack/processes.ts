// DAN-759: the processes of the VS-1 stack. Each starts detached in its own
// process group with its output in a log file, and is stopped only through
// the id the state file recorded, and only while its command line still holds
// the marker it was started with, so a reused id or another stack's process
// is never signalled.
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { connect } from "node:net";

type Env = Record<string, string>;
export type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts `command` detached; resolves to its pid once it was spawned. */
export function startDetached(
  command: string,
  args: readonly string[],
  { cwd, env, log }: { cwd: string; env: Env; log: string },
): Promise<number> {
  const out = openSync(log, "a", 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid as number);
    });
  });
}

/** Polls `url` until it answers 200; false after `timeoutMs`. */
export async function waitHealthy(
  url: string,
  timeoutMs: number,
  { get = fetch, wait = sleep }: { get?: typeof fetch; wait?: Wait } = {},
): Promise<boolean> {
  for (let left = timeoutMs; left > 0; left -= 250) {
    const ok = await get(url, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.status === 200,
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
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** The whole command line of `pid` (never cut to COLUMNS), or null when no such process exists. */
export function commandLine(pid: number): string | null {
  const env = { PATH: process.env.PATH ?? "" };
  try {
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      env,
    }).trim();
  } catch {
    return null;
  }
}

export type StopDeps = {
  command?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: Wait;
};

// A group that exits between the check and the signal is already stopped.
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "ESRCH") throw error;
  }
}

/**
 * Stops the process group of `pid` if its command line is exactly `marker`:
 * SIGTERM, then SIGKILL after `graceMs`. "gone" when it had already exited,
 * "foreign" when the id now belongs to something else (left alone).
 */
export async function stopProcess(
  pid: number,
  marker: string,
  graceMs: number,
  {
    command = commandLine,
    kill = (id, signal) => process.kill(-id, signal),
    wait = sleep,
  }: StopDeps = {},
): Promise<"stopped" | "gone" | "foreign"> {
  if (!Number.isInteger(pid) || pid <= 1) return "foreign";
  const line = command(pid);
  if (line === null) return "gone";
  if (line !== marker) return "foreign";
  // An exited child not yet reaped shows as <defunct>, not as the marker.
  const alive = (): boolean => command(pid) === marker;
  kill(pid, "SIGTERM");
  for (let left = graceMs; left > 0; left -= 100) {
    if (!alive()) return "stopped";
    await wait(100);
  }
  kill(pid, "SIGKILL");
  for (let tries = 0; tries < 20 && alive(); tries += 1) await wait(100);
  return "stopped";
}
