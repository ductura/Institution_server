// POST /api/v1/client-error (DAN-1568). The web reports an error nobody
// caught in the browser: its kind, its class, the page of the app and the
// app's version, each from a closed list. Anything else is 400, so no field
// can carry a message, a stack, an address or anything a person typed.
// The route works without a login and never reads the session: the record is
// `anonymous` and nothing here decides access. Origin is pipeline step 7 and
// the rate limit step 4 (class default). The record is never awaited and
// never changes the 204. As client-context.ts, whose form of body it shares.
import { CLIENT_APP_VERSION_PATTERN, CLIENT_ERROR_VALUES, ROUTES } from "../contracts/index.ts";
import { logEvent, type LogEvent, type LogWriter } from "../log/index.ts";

import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import type { Route } from "./router.ts";
import { refuse } from "./security-headers.ts";

const ERROR_ID = "client.error.post";
const found = ROUTES.find((route) => route.id === ERROR_ID);
if (found === undefined) throw new Error(`no contract ${ERROR_ID}`);
const contract = found;

export const CLIENT_ERROR_MAX_BYTES = contract.request.maxBodyBytes ?? 256;
export const CLIENT_ERROR_TIMEOUT_MS = 5_000;

type Lists = typeof CLIENT_ERROR_VALUES;
export type ClientError = { readonly [K in keyof Lists]: Lists[K][number] } & {
  readonly appVersion: string;
};
export type ClientErrorParse =
  | { readonly ok: true; readonly value: ClientError }
  | { readonly ok: false; readonly code: "invalid_json" | "invalid_input" };

const VERSION_RE = new RegExp(CLIENT_APP_VERSION_PATTERN, "u");
const LIST_FIELDS = Object.keys(CLIENT_ERROR_VALUES) as (keyof Lists & string)[];
/** Every field, in JCS (code point) order. */
const FIELDS: readonly string[] = [...LIST_FIELDS, "appVersion"].sort();
const INVALID_INPUT: ClientErrorParse = { ok: false, code: "invalid_input" };

/**
 * The report from the exact JCS bytes of the closed body. Strict UTF-8 and
 * JSON.parse, or invalid_json. Then exactly the four own keys, each a string
 * on its closed list, and the bytes must equal the JCS text of the value,
 * which refuses a duplicate key, white space, escapes and another key order.
 * Anything else is invalid_input.
 */
export function parseClientError(bytes: Uint8Array): ClientErrorParse {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return INVALID_INPUT;
  const record = value as Record<string, unknown>;
  const own = Object.keys(record).sort();
  if (own.length !== FIELDS.length || own.some((key, i) => key !== FIELDS[i])) {
    return INVALID_INPUT;
  }
  const version = record.appVersion;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return INVALID_INPUT;
  for (const field of LIST_FIELDS) {
    const list: readonly unknown[] = CLIENT_ERROR_VALUES[field];
    if (typeof record[field] !== "string" || !list.includes(record[field])) return INVALID_INPUT;
  }
  // Every value is a plain ASCII word or path here, so JSON.stringify of each is its JCS form.
  const canonical = `{${FIELDS.map((key) => `"${key}":${JSON.stringify(record[key])}`).join(",")}}`;
  if (canonical !== text) return INVALID_INPUT;
  const report = Object.fromEntries(FIELDS.map((key) => [key, record[key]]));
  return { ok: true, value: Object.freeze(report) as ClientError };
}

export type ClientErrorOptions = {
  /** The log service. Without it the report is one line of the process log. */
  readonly log?: LogWriter;
  /** The process log used without `log`; for tests. */
  readonly line?: LogEvent;
  /** For tests: the clock of the record and a shorter body deadline. */
  readonly now?: () => Date;
  readonly timeoutMs?: number;
};

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

export function createClientErrorRoute(options: ClientErrorOptions = {}): Route {
  const now = options.now ?? (() => new Date());
  const line = options.line ?? logEvent;
  const timeoutMs = options.timeoutMs ?? CLIENT_ERROR_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(request, CLIENT_ERROR_MAX_BYTES, timeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      const parsed = parseClientError(body.bytes);
      if (!parsed.ok) return sendProblem(response, 400, parsed.code);
      const { log } = options;
      // Read before the answer starts: the first call also sets the response header.
      const requestId = requestIdOf(response);
      if (log === undefined) {
        // No log service is wired into the process yet; the values are closed
        // codes, so the line can hold nothing a person wrote.
        line("warn", "client.error_reported", { ...parsed.value });
      } else {
        // Handed over without waiting; a throw or rejection is dropped.
        void Promise.resolve()
          .then(() =>
            log({
              time: now().toISOString(),
              event: "client.error_reported",
              requestId,
              accountKind: "anonymous",
              fields: parsed.value,
            }),
          )
          .catch(() => undefined);
      }
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    },
  };
}
