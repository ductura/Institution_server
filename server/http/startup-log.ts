// The lines of the entry point before and around the start (SRV-1812, plan
// M11.3; the "instrumentation with a refused database URL" case of Ductus
// src/server/log/canary.test.ts): each one is a structured JSON line of
// server/log, so redact runs over it like over every other line. A refused
// environment is one `startup.refused` line per problem, by variable name
// only, and the process ends with EXIT_CONFIGURATION (server/config); a start
// that fails later is `startup.failed` with the system code (EADDRINUSE,
// EACCES) or, for a programming error of the route table, its message.
import { logEvent, type LogEvent } from "../log/index.ts";

/** One `startup.refused` line per problem; the problems name variables, never values. */
export function logStartupRefused(problems: readonly string[], log: LogEvent = logEvent): void {
  for (const problem of problems) log("error", "startup.refused", { problem });
}

/** The `startup.failed` line of `error`: its own string code, else its message through redact. */
export function logStartupFailed(error: unknown, log: LogEvent = logEvent): void {
  let code: unknown;
  let message: unknown;
  try {
    ({ code, message } = (error ?? {}) as { code?: unknown; message?: unknown });
  } catch {
    // A getter that throws: nothing of it is kept.
  }
  if (typeof code === "string") log("error", "startup.failed", { code });
  else log("error", "startup.failed", { message: typeof message === "string" ? message : "" });
}
