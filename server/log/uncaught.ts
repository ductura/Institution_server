import { writeSync } from "node:fs";

import { createLogger, type LogEvent, type LogSink } from "./logger.ts";

/**
 * Errors nobody caught (DAN-1567): `uncaughtException` and
 * `unhandledRejection` of the process. Node's own answer is to print the
 * error with its message and stack and exit 1; a message can quote a value,
 * so that print may carry text of a work or a person. Here the error becomes
 * one line of two closed codes, and the process still exits 1.
 *
 * Of the error itself only its class and the place it was thrown are kept:
 * a file of this repository and a line number (owner decision of 25 Nov
 * 2026). No message, no other part of the stack, no property. The same
 * origin, class and place within `windowMs` is one group: one line and one
 * alarm for the first, a count for the rest.
 */

export const UNCAUGHT_ORIGINS = ["uncaught_exception", "unhandled_rejection"] as const;
export type UncaughtOrigin = (typeof UNCAUGHT_ORIGINS)[number];

/** The classes of `error.unexpected` in the event catalogue (events/catalog.ts). */
export const UNCAUGHT_ERROR_CLASSES = [
  ...(["type_error", "range_error", "reference_error", "syntax_error"] as const),
  ...(["database_error", "timeout", "other"] as const),
] as const;
export type UncaughtErrorClass = (typeof UNCAUGHT_ERROR_CLASSES)[number];

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The class of a thrown value, read from its prototype and two own data
 * properties. Never throws and never runs code of the value: a getter, a
 * Proxy or a value that is not an error is `other`.
 */
export function errorClassOf(error: unknown): UncaughtErrorClass {
  try {
    if (error instanceof TypeError) return "type_error";
    if (error instanceof RangeError) return "range_error";
    if (error instanceof ReferenceError) return "reference_error";
    if (error instanceof SyntaxError) return "syntax_error";
    if (typeof error !== "object" || error === null) return "other";
    const own = (key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(error, key);
      return property !== undefined && "value" in property ? property.value : undefined;
    };
    const code = own("code");
    if (own("name") === "TimeoutError" || code === "ETIMEDOUT") return "timeout";
    // A PostgreSQL error carries a five-character SQLSTATE and a severity.
    if (typeof code === "string" && SQLSTATE.test(code) && typeof own("severity") === "string") {
      return "database_error";
    }
    return "other";
  } catch {
    return "other";
  }
}

/** The engine's own getter of `stack`, the same function on every error. */
const NATIVE_STACK = Object.getOwnPropertyDescriptor(new Error("probe"), "stack")?.get;

// A file of this repository's own code: a relative path of plain characters
// under one of its folders. Absolute prefixes are dropped; node: and
// node_modules files never match.
const OWN_FILE =
  /(?:^|\/)((?:server|scripts|packages|dist)\/[A-Za-z0-9_.\/-]{1,160}\.(?:ts|js|mjs))$/;

/** Where nothing of our own code is on the stack, or the stack cannot be read safely. */
export const UNKNOWN_SITE = "unknown";

/** One frame as the engine reports it: a file name or URL and a line. */
export type StackFrame = { file: string | null; line: number | null };

/** The first of `frames` in this repository's code, as `server/area/file.ts:12`. */
export function siteOfFrames(frames: readonly StackFrame[]): string {
  for (const { file, line } of frames.slice(0, 50)) {
    if (typeof file !== "string" || file.includes("node_modules")) continue;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > 9_999_999)
      continue;
    const own = OWN_FILE.exec(file);
    if (own !== null) return `${own[1]}:${line}`;
  }
  return UNKNOWN_SITE;
}

type CallSite = { getFileName(): string | null; getLineNumber(): number | null };
const PREPARE = "prepareStackTrace";

/**
 * The place `error` was thrown at. The frames come from the engine as
 * structured call sites, never from the text of the stack: the text begins
 * with the message, and a message of several lines can look like a frame.
 * Reading them does not format the error, so no getter of its name or
 * message runs. An error whose stack someone already read, replaced or
 * defined (no engine getter, or a stack already turned into text) is
 * `unknown`. Never throws. Afterwards the error's own `stack` is empty.
 */
export function errorSiteOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return UNKNOWN_SITE;
    const property = Object.getOwnPropertyDescriptor(error, "stack");
    if (NATIVE_STACK === undefined || property?.get !== NATIVE_STACK) return UNKNOWN_SITE;
    const previous = Object.getOwnPropertyDescriptor(Error, PREPARE);
    let sites: readonly CallSite[] | null = null;
    Object.defineProperty(Error, PREPARE, {
      configurable: true,
      writable: true,
      value: (_error: unknown, callSites: readonly CallSite[]) => {
        sites = callSites;
        return "";
      },
    });
    try {
      Reflect.apply(NATIVE_STACK, error, []);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Error, PREPARE);
      else Object.defineProperty(Error, PREPARE, previous);
    }
    const read = sites as readonly CallSite[] | null;
    if (read === null) return UNKNOWN_SITE;
    return siteOfFrames(
      read.slice(0, 50).map((site) => ({ file: site.getFileName(), line: site.getLineNumber() })),
    );
  } catch {
    return UNKNOWN_SITE;
  }
}

export type UncaughtGroup = {
  origin: UncaughtOrigin;
  errorClass: UncaughtErrorClass;
  /** `server/area/file.ts:12`, or `unknown`. */
  site: string;
};

export type UncaughtCaptureOptions = {
  log?: LogEvent;
  /** Milliseconds; only differences are used. */
  now?: () => number;
  /** How long a group stays one group. Default one minute. */
  windowMs?: number;
  /**
   * Called once per group and window, for an alarm. Not wired to
   * identity.ops_alarm: its kinds are a closed set without one for this.
   */
  raise?: (group: UncaughtGroup) => void;
};

export type UncaughtCapture = {
  /** Records one error; true when it opened a group (a line and an alarm). */
  capture(origin: UncaughtOrigin, error: unknown): boolean;
  /** Writes the count of every group that repeated, and forgets all groups. */
  flush(): void;
};

export const UNCAUGHT_WINDOW_MS = 60_000;

/**
 * Writes the line to stderr before it returns. The process exits right after
 * the line is written, and `console.error` to a pipe may still be on its way
 * then; a crash must not lose the one line that says it happened.
 */
export const stderrSyncSink: LogSink = (_level, line) => {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // A stderr that cannot take a synchronous write (EAGAIN on a full pipe).
    console.error(line);
  }
};
const fatalLog = createLogger(stderrSyncSink);

export function createUncaughtCapture(options: UncaughtCaptureOptions = {}): UncaughtCapture {
  const log = options.log ?? fatalLog;
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? UNCAUGHT_WINDOW_MS;
  const groups = new Map<string, UncaughtGroup & { openedAt: number; repeats: number }>();

  const close = (key: string) => {
    const group = groups.get(key);
    groups.delete(key);
    if (group !== undefined && group.repeats > 0) {
      const { origin, errorClass, site, repeats } = group;
      log("error", "error.uncaught_repeated", { origin, errorClass, site, repeats });
    }
  };

  return {
    capture(origin, error) {
      const errorClass = errorClassOf(error);
      const site = errorSiteOf(error);
      const key = `${origin}:${errorClass}:${site}`;
      const open = groups.get(key);
      if (open !== undefined && now() - open.openedAt < windowMs) {
        open.repeats += 1;
        return false;
      }
      close(key);
      groups.set(key, { origin, errorClass, site, openedAt: now(), repeats: 0 });
      log("error", "error.uncaught", { origin, errorClass, site });
      try {
        options.raise?.({ origin, errorClass, site });
      } catch {
        // An alarm that cannot be raised must not hide the line above.
      }
      return true;
    },
    flush() {
      for (const key of [...groups.keys()]) close(key);
    },
  };
}

type Listener = (error: unknown) => void;
export type UncaughtTarget = {
  on(event: "uncaughtException" | "unhandledRejection", listener: Listener): unknown;
  off(event: "uncaughtException" | "unhandledRejection", listener: Listener): unknown;
};

/**
 * Listens on `target` (the process). Each error is captured, the counts are
 * written, and `exit(1)` is called: a process that met an error nobody caught
 * is in an unknown state and must not go on, as Node itself decides. Returns
 * the function that stops listening.
 */
export function installUncaughtCapture(
  target: UncaughtTarget,
  options: { exit: (code: 1) => unknown; capture?: UncaughtCapture },
): () => void {
  const capture = options.capture ?? createUncaughtCapture();
  const handle = (origin: UncaughtOrigin) => (error: unknown) => {
    capture.capture(origin, error);
    capture.flush();
    options.exit(1);
  };
  const onException = handle("uncaught_exception");
  const onRejection = handle("unhandled_rejection");
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}
