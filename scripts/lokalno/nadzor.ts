// VS-1.13 (A06) on Windows: `pnpm lokalno` stops the whole stack when one of
// its children exits. A test that restarts the server on purpose announces it
// first, so the supervisor waits for the server instead of stopping the stack.
// Linux CI does not use this: there `stog-bez-nadzora.mjs` of the web front
// takes the stack over through /proc (Institution_front_web_chrome).
//
// Files in `.local/` (never committed), no environment and no secrets:
//   nadzor.json          written by the supervisor: its PID, the server's PID,
//                        command line and working directory
//   nadzor-server.stani  written by the test before it stops the server
//   nadzor-server.pokreni written by the test once the server is down; the
//                        supervisor then starts the same command again
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SUPERVISOR_FILE = "nadzor.json";
export const STOP_FILE = "nadzor-server.stani";
export const START_FILE = "nadzor-server.pokreni";
/** How long the supervisor waits for `nadzor-server.pokreni` after a planned stop. */
export const START_WAIT_MS = 120_000;

export type SupervisorState = {
  readonly protocol: 1;
  readonly supervisor: number;
  readonly server: { readonly pid: number; readonly argv: readonly string[]; readonly cwd: string };
};

export function supervisorState(
  supervisor: number,
  server: { pid: number; argv: readonly string[]; cwd: string },
): SupervisorState {
  return {
    protocol: 1,
    supervisor,
    server: { pid: server.pid, argv: [...server.argv], cwd: server.cwd },
  };
}

export function writeSupervisorState(localDir: string, state: SupervisorState): void {
  writeFileSync(join(localDir, SUPERVISOR_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Removes the state and any request left behind, when the supervisor ends. */
export function clearSupervisorFiles(localDir: string): void {
  for (const name of [SUPERVISOR_FILE, STOP_FILE, START_FILE])
    rmSync(join(localDir, name), { force: true });
}

/**
 * True when the server's exit was announced: the stop request is consumed, so
 * one announcement covers one exit. An unannounced exit stops the stack as
 * before.
 */
export function takeStopRequest(localDir: string): boolean {
  const file = join(localDir, STOP_FILE);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Waits for the start request and consumes it; false when the time is up. */
export async function waitForStartRequest(
  localDir: string,
  timeoutMs = START_WAIT_MS,
  pollMs = 200,
): Promise<boolean> {
  const file = join(localDir, START_FILE);
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/** The supervisor's state, or null when there is none or it is not protocol 1. */
export function readSupervisorState(localDir: string): SupervisorState | null {
  const file = join(localDir, SUPERVISOR_FILE);
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Partial<SupervisorState>;
    return state.protocol === 1 &&
      typeof state.supervisor === "number" &&
      typeof state.server?.pid === "number"
      ? (state as SupervisorState)
      : null;
  } catch {
    return null;
  }
}
