import {
  type CatalogErrorCode,
  checkEvent,
  EVENT_CATALOG,
  type FieldSpec,
  type LogRecord,
} from "./events/index.ts";
import { createLogger, type LogEvent } from "./logger.ts";
import { redact } from "./redact.ts";

/**
 * The log service (S-1K.3-a, DAN-807): the one way an area writes a record to
 * the log database. A record is first checked against the closed event catalog
 * (S-1K.1), then passes `redact` once more as a second net (S-0.17), and only
 * then reaches the store. The stored payload is the frozen copy `checkEvent`
 * made, never the caller's object. A refused record is never stored.
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

export type LogWriterError = {
  readonly code: CatalogErrorCode | LogWriterErrorCode;
  readonly messageKey: string;
};

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

/**
 * The record as `redact` must leave it: route fields are blanked first. A
 * route value passed the catalog only as an exact member of the server's own
 * route inventory, so it carries no free text, yet a long template such as
 * `/api/v1/evidence/commit` has the shape `redact` takes for a token.
 */
function withoutRoutes(record: LogRecord): LogRecord {
  const specs: Readonly<Record<string, FieldSpec>> = EVENT_CATALOG[record.event].fields;
  const fields: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(record.fields))
    fields[name] = specs[name]?.kind === "route" ? "" : value;
  return { ...record, fields };
}

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
    try {
      // Apart from route templates, the catalog admits no value redact would
      // change; a record it changes anyway is not stored, so a gap in either
      // net cannot leak through.
      const probe = withoutRoutes(record);
      if (JSON.stringify(redact(probe)) !== JSON.stringify(probe)) {
        silent(fallback, "log_refused", "LOG_REDACTED");
        return fail("LOG_REDACTED");
      }
      await store.append(record.event, record);
    } catch {
      silent(fallback, "log_store_failed", "LOG_STORE_FAILED");
      return fail("LOG_STORE_FAILED");
    }
    return { ok: true, value: record };
  };
}
