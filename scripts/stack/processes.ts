// DAN-759: processes of the VS-1 stack. Each starts detached in its own process
// group, logging to a file, and is stopped only through the recorded id and only
// while its command line is still exactly the recorded one, so a reused id or
// another stack's process is never signalled.
import { execFileSync, spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
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

/**
 * Polls `url` until it answers 200; false once `timeoutMs` has passed, counted
 * on the clock, so requests that hang use up the time as well as the pauses.
 */
export async function waitHealthy(
  url: string,
  timeoutMs: number,
  get = fetch,
  wait = sleep,
  now = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (let left = timeoutMs; left > 0; left = deadline - now()) {
    const signal = AbortSignal.timeout(Math.min(1000, left));
    if (
      await get(url, { signal }).then(
        (r) => r.status === 200,
        () => false,
      )
    )
      return true;
    if (deadline - now() <= 0) break;
    await wait(Math.min(250, deadline - now()));
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

/** The options the stack starts its postmaster with (pg_ctl -o). */
export const postgresOptions = (port: number, socketDir: string): string =>
  `-p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700`;

/**
 * True only for the stack's own postmaster: a `postgres` binary given exactly
 * `-D <pgdata>` and the stack's options, as pg_ctl starts it. A reused pid
 * whose arguments merely contain that text is not ours.
 */
export function isStackPostmaster(
  line: string,
  pgdata: string,
  socketDir: string,
  port: number,
): boolean {
  const args = ` -D ${pgdata} ${postgresOptions(port, socketDir)}`;
  if (!line.endsWith(args)) return false;
  const binary = line.slice(0, -args.length);
  return binary.startsWith("/") && binary.endsWith("/postgres") && !/\s/u.test(binary);
}

// The inode of a socket an fd of `pid` holds, or null.
function socketInode(pid: number, fd: string): string | null {
  try {
    return /^socket:\[(\d+)\]$/u.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` itself holds a listening TCP socket on `port` (Linux /proc).
 * A 200 from the port alone may come from another process, for example the
 * server of another checkout that took the port first.
 */
export function listensOn(pid: number, port: number): boolean {
  let inodes: Set<string>;
  try {
    inodes = new Set(readdirSync(`/proc/${pid}/fd`).map((fd) => socketInode(pid, fd) ?? ""));
  } catch {
    return false;
  }
  const local = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  return ["tcp", "tcp6"].some((table) => {
    let rows: string[];
    try {
      rows = readFileSync(`/proc/${pid}/net/${table}`, "utf8").split("\n").slice(1);
    } catch {
      return false;
    }
    // Columns: sl local_address rem_address st ... inode (10th); 0A is LISTEN.
    return rows.some((row) => {
      const cols = row.trim().split(/\s+/u);
      return cols[1]?.endsWith(local) === true && cols[3] === "0A" && inodes.has(cols[9] ?? "");
    });
  });
}

/** Health answers 200 and the answer comes from `pid` itself listening on `port`. */
export async function serverReady(
  url: string,
  pid: number,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return (await waitHealthy(url, timeoutMs)) && listensOn(pid, port);
}
