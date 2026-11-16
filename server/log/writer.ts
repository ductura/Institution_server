import { checkEvent, type LogRecord } from "./events/index.ts";
import { createLogger, type LogEvent } from "./logger.ts";
import { redact } from "./redact.ts";

/**
 * The log service (S-1K.3-a, DAN-807): the one way an area writes a record to
 * the log database. A record is first checked against the closed event catalog
 * (S-1K.1), then passes `redact` once more as a second net (S-0.17), and only
 * then reaches the store. A refused record is never stored.
 *
 * `write` never throws and never hands a refused value or a store message on:
 * the fallback console line carries only a fixed event and a closed code,
 * because a refused value or a database message may hold the very text the
 * catalog keeps out.
 */

/** The port to the log database; `append` of the fake log database fits it. */
export type LogStore = {
  append(kind: string, payload: unknown): unknown;
};

export const LOG_WRITER_ERROR_CODES = Object.freeze(["LOG_REDACTED", "LOG_STORE_FAILED"] as const);

export type LogWriterErrorCode = (typeof LOG_WRITER_ERROR_CODES)[number];

export type LogWriterError = { readonly code: string; readonly messageKey: string };

export type LogWriteResult =
  | { readonly ok: true; readonly value: LogRecord }
  | { readonly ok: false; readonly error: LogWriterError };

export type LogWriter = (input: unknown) => Promise<LogWriteResult>;

export type LogWriterOptions = {
  readonly store: LogStore;
  /** Route templates of the server's inventory, passed to `checkEvent`. */
  readonly routes: ReadonlySet<string>;
  /** Where the fixed refusal and failure lines go; the console log by default. */
  readonly fallback?: LogEvent;
};

const fail = (code: LogWriterErrorCode): LogWriteResult =>
  Object.freeze({
    ok: false,
    error: Object.freeze({ code, messageKey: `logWriter.${code.toLowerCase()}` }),
  });

const silent = (fallback: LogEvent, event: string, code: string): void => {
  try {
    fallback("error", event, { code });
  } catch {
    // The fallback is the last place a line can go; nothing more to do.
  }
};

export function createLogWriter(options: LogWriterOptions): LogWriter {
  const { store, routes } = options;
  const fallback = options.fallback ?? createLogger();

  return async (input) => {
    const checked = checkEvent(input, { routes });
    if (!checked.ok) {
      silent(fallback, "log_refused", checked.error.code);
      return checked;
    }
    const record = checked.value;
    let payload: unknown;
    try {
      payload = redact(record);
      // The catalog admits no value redact would change; a record it changes
      // anyway is not stored, so a gap in either net cannot leak through.
      if (JSON.stringify(payload) !== JSON.stringify(record)) {
        silent(fallback, "log_refused", "LOG_REDACTED");
        return fail("LOG_REDACTED");
      }
      await store.append(record.event, payload);
    } catch {
      silent(fallback, "log_store_failed", "LOG_STORE_FAILED");
      return fail("LOG_STORE_FAILED");
    }
    return { ok: true, value: record };
  };
}
