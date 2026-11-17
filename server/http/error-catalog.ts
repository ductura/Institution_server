// The error catalogue of the preloader (S-1M-c, DAN-802): every error status a
// client shows has a code and a message key with a text in locales/ (hr, en).
// Statuses the server answers use the contract's own error (server/contracts,
// SERVER_ERRORS), so the key equals the messageKey of the problem body; the
// ones only a proxy or a later task gives (502, 504, session_expired) have
// their texts under clientErrors. 429 is the shared too_many_requests of the
// rate limit (DAN-814) even when a route answers it with its own code
// (ROUTE_429_CODES). Also the one record of an uncaught
// error (server_error), written by the router, the pipeline and the server.
// The entries are data (DAN-928): server/contracts/routes/error-catalog.json,
// which @ductura/contracts publishes as errors/catalog.json.
import { ERROR_CATALOG_DATA } from "../contracts/index.ts";
import type { LogWriter } from "../log/index.ts";

export type CatalogError = {
  readonly status: number;
  readonly code: string;
  readonly messageKey: string;
};

const entry = (status: number, code: string, messageKey: string): CatalogError =>
  Object.freeze({ status, code, messageKey });

/** Every entry: ten statuses and session_expired (a 401 picked by code, not by status). */
export const ERROR_CATALOG: readonly CatalogError[] = Object.freeze(
  ERROR_CATALOG_DATA.errors.map(({ status, code, messageKey }) => entry(status, code, messageKey)),
);

function entryOf(code: string): CatalogError {
  const found = ERROR_CATALOG.find((error) => error.code === code);
  if (found === undefined) throw new Error(`error-catalog.json: no ${code}`);
  return found;
}

const BAD_REQUEST = entryOf("bad_request");
const INTERNAL = entryOf("internal");

/**
 * The 429 codes a route of the contract may answer (DAN-803, Ductus#1836
 * c.6905799359 N2, decision c.6905867488): Ductus's own words for a limit of
 * one action. The catalogue keeps the generic too_many_requests for 429, so a
 * client that knows only the status still shows one text; any other 429 code
 * in the contract fails server/http/error-catalog.test.ts.
 */
export const ROUTE_429_CODES: readonly string[] = Object.freeze([
  "too_many_reports",
  "too_many_attempts",
]);

/** Every contract error that breaks the rule of ROUTE_429_CODES. */
export function route429Problems(errors: readonly { status: number; code: string }[]): string[] {
  return errors.flatMap((error) => {
    const listed = ROUTE_429_CODES.includes(error.code);
    if (error.status === 429 && !listed) return [`429 ${error.code}: not a route 429 code`];
    if (error.status !== 429 && listed)
      return [`${error.status} ${error.code}: a route 429 code on another status`];
    return [];
  });
}

/** The code that is looked up by name only; by status 401 stays unauthenticated. */
export const SESSION_EXPIRED = "session_expired";

const BY_STATUS: ReadonlyMap<number, CatalogError> = new Map(
  ERROR_CATALOG.filter((error) => error.code !== SESSION_EXPIRED).map((error) => [
    error.status,
    error,
  ]),
);
const BY_CODE: ReadonlyMap<string, CatalogError> = new Map(
  ERROR_CATALOG.map((error) => [error.code, error]),
);

/**
 * The entry a client shows for a status: its own, else 400 for any other 4xx
 * and 500 for anything else (5xx, below 400, not an integer). Never throws.
 */
export function catalogErrorFor(status: unknown): CatalogError {
  if (typeof status !== "number" || !Number.isInteger(status)) return INTERNAL;
  const own = BY_STATUS.get(status);
  if (own !== undefined) return own;
  return status >= 400 && status < 500 ? BAD_REQUEST : INTERNAL;
}

/** The entry of a code, or undefined; only the catalogue's own codes, never inherited names. */
export function catalogErrorOf(code: string): CatalogError | undefined {
  return BY_CODE.get(code);
}

/** Where an uncaught error was caught: a route handler, a layer, or the whole request. */
export type ServerErrorSite = "route" | "layer" | "request";

/** The closed classes of errorClass, a subset of error.unexpected in server/log. */
export const SERVER_ERROR_CLASSES = Object.freeze([
  "type_error",
  "range_error",
  "reference_error",
  "syntax_error",
  "other",
] as const);

export type ServerErrorClass = (typeof SERVER_ERROR_CLASSES)[number];

const CLASS_BY_NAME: ReadonlyMap<string, ServerErrorClass> = new Map([
  ["TypeError", "type_error"],
  ["RangeError", "range_error"],
  ["ReferenceError", "reference_error"],
  ["SyntaxError", "syntax_error"],
]);

// The names errorName passes on; any other name (a subclass, a name set from
// data) is logged as "Error", so nothing from a request reaches the log.
const BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/**
 * The name of a thrown value for the log, never its message. Reading it never
 * throws: a throwing "name" getter, a Proxy or a revoked Proxy give a fixed word.
 */
export function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return error === null ? "null" : typeof error;
    const name: unknown = error.name;
    return typeof name === "string" && BUILT_IN_NAMES.has(name) ? name : "Error";
  } catch {
    return "unreadable";
  }
}

/** The class of a thrown value; reading it never throws and never reads the message. */
export function serverErrorClass(error: unknown): ServerErrorClass {
  return CLASS_BY_NAME.get(errorName(error)) ?? "other";
}

export type ServerErrorRecord = {
  readonly event: "server_error";
  readonly where: ServerErrorSite;
  readonly errorClass: ServerErrorClass;
  readonly requestId: string;
  readonly route?: string;
};

/**
 * Records an uncaught error as one JSON line on stderr (event server_error):
 * only the site, the closed class, the request id and the route's contract
 * id. Never the message, stack, name of a subclass, URL, headers or body.
 * A server with a log service writes error.unexpected instead
 * (createServerErrorReporter, S-1K.3-b). Never throws.
 */
export function reportServerError(
  where: ServerErrorSite,
  error: unknown,
  requestId: string,
  route?: string,
): void {
  const record: ServerErrorRecord = {
    event: "server_error",
    where,
    errorClass: serverErrorClass(error),
    requestId,
    ...(route === undefined ? {} : { route }),
  };
  try {
    console.error(JSON.stringify(record));
  } catch {
    // A broken stderr must not turn the 500 into a crash.
  }
}

/** How a site of the server records an uncaught error; reportServerError by default. */
export type ServerErrorReporter = typeof reportServerError;

/**
 * The reporter of one server (S-1K.3-b, DAN-812). Without a log service it is
 * reportServerError. With one, an uncaught error becomes error.unexpected
 * (area "http", the same closed errorClass, the same request id) and the
 * write is never awaited: the 500 leaves at once whatever state the log
 * database is in, and `write` itself never throws. A record the log database
 * does not take goes to the writer's fallback line instead (writer.ts).
 */
export function createServerErrorReporter(log?: LogWriter): ServerErrorReporter {
  if (log === undefined) return reportServerError;
  return (_where, error, requestId) => {
    try {
      void log({
        time: new Date().toISOString(),
        event: "error.unexpected",
        requestId,
        accountKind: "anonymous",
        fields: { area: "http", errorClass: serverErrorClass(error) },
      }).catch(() => {});
    } catch {
      // A writer that breaks its promise and throws must not turn the 500 into a crash.
    }
  };
}
