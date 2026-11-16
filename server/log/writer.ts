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

export const LOG_WRITER_ERROR_CODES = Object.freeze([
  "LOG_REDACTED",
  "LOG_STORE_FAILED",
  "LOG_STORE_TIMEOUT",
  "LOG_STORE_BUSY",
] as const);

/**
 * How long one write waits for the store (S-1K.3-b, DAN-812). A request never
 * waits for a write at all; the deadline only bounds how long a record holds
 * one of the pending places while the log database is slow or hangs.
 */
export const LOG_WRITE_DEADLINE_MS = 1_000;
/** Writes that may wait for the store at once; past it a record goes to the fallback. */
export const LOG_MAX_PENDING = 64;

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
  /** Longest wait for `append`, a positive whole number of ms; LOG_WRITE_DEADLINE_MS by default. */
  readonly deadlineMs?: number;
  /** Most appends pending at once, a positive whole number; LOG_MAX_PENDING by default. */
  readonly maxPending?: number;
};

const fail = (code: LogWriterErrorCode): LogWriteResult =>
  Object.freeze({
    ok: false,
    error: Object.freeze({ code, messageKey: `logWriter.${code.toLowerCase()}` }),
  });

/**
 * The record as `redact` must leave it: route fields are blanked and client
 * IP fields left out first. A route value passed the catalog only as an exact
 * member of the server's own route inventory, so it carries no free text, yet
 * a long template such as `/api/v1/evidence/commit` has the shape `redact`
 * takes for a token. A client IP passed only as an address or `none`, under a
 * name `redact` drops whatever its value (DAN-831-1).
 */
function withoutRoutes(record: LogRecord): LogRecord {
  const specs: Readonly<Record<string, FieldSpec>> = EVENT_CATALOG[record.event].fields;
  const fields: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(record.fields)) {
    const kind = specs[name]?.kind;
    if (kind !== "ip") fields[name] = kind === "route" || kind === "routeOrNone" ? "" : value;
  }
  return { ...record, fields };
}

const silent = (fallback: LogEvent, event: string, code: string, record?: LogRecord): void => {
  try {
    fallback("error", event, record === undefined ? { code } : { code, record });
  } catch {
    // The fallback is the last place a line can go; nothing more to do.
  }
};

const TIMED_OUT = Symbol("timed out");

/**
 * `append` raced against `ms`. `done` settles when `append` itself does, never
 * rejecting, so a place stays taken while a write the deadline gave up on
 * still holds the store: maxPending bounds what a hanging log database can
 * hold, and the store's adapter must settle every append (its own query
 * timeout) for places to come back.
 */
function appendWithin(
  store: LogStore,
  record: LogRecord,
  ms: number,
): { readonly outcome: Promise<typeof TIMED_OUT | undefined>; readonly done: Promise<void> } {
  // A throwing append or a throwing `then` of its result rejects `work`; it
  // never throws synchronously here.
  const work = Promise.resolve().then(() => store.append(record.event, record));
  const done = work.then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // A hanging log database never keeps the process up.
    timer.unref?.();
  });
  const outcome = Promise.race([work.then(() => undefined), late]).finally(() =>
    clearTimeout(timer),
  );
  return { outcome, done };
}

/** The longest delay setTimeout keeps; a longer one Node silently makes 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function positiveWhole(
  value: number | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive whole number`);
  }
  return value;
}

export function createLogWriter(options: LogWriterOptions): LogWriter {
  const { store, routes } = options;
  const fallback = options.fallback ?? createLogger();
  const deadlineMs = positiveWhole(
    options.deadlineMs,
    LOG_WRITE_DEADLINE_MS,
    "deadlineMs",
    MAX_TIMER_MS,
  );
  const maxPending = positiveWhole(options.maxPending, LOG_MAX_PENDING, "maxPending");
  let pending = 0;

  // A record the store did not take is not lost silently: the fallback line
  // carries it, already checked by the catalog and by redact (DAN-812).
  const unstored = (code: LogWriterErrorCode, record: LogRecord): LogWriteResult => {
    silent(fallback, "log_store_failed", code, record);
    return fail(code);
  };

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
    } catch {
      silent(fallback, "log_store_failed", "LOG_STORE_FAILED");
      return fail("LOG_STORE_FAILED");
    }
    if (pending >= maxPending) return unstored("LOG_STORE_BUSY", record);
    pending += 1;
    const { outcome, done } = appendWithin(store, record, deadlineMs);
    void done.then(() => (pending -= 1));
    try {
      if ((await outcome) === TIMED_OUT) return unstored("LOG_STORE_TIMEOUT", record);
    } catch {
      return unstored("LOG_STORE_FAILED", record);
    }
    return { ok: true, value: record };
  };
}
