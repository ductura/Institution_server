// POST /api/v1/client-context (S-1M-b, DAN-846; Ductus D-300, contract
// Ductus#1836 c.6914739131). The preloader sends its environment once: app,
// version, system, browser, device and a screen width class, each from a
// closed list. Anything else is 400, so no field can carry a fingerprint.
// The route works without a login and never reads the session: the record is
// `anonymous` and nothing here decides access. Origin is pipeline step 7 and
// the rate limit step 4 (class default). The record ties to the request by
// its id; the log write is never awaited and never changes the 204.
import { CLIENT_APP_VERSION_PATTERN, CLIENT_CONTEXT_VALUES, ROUTES } from "../contracts/index.ts";
import type { LogWriter } from "../log/index.ts";

import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import type { Route } from "./router.ts";
import { refuse } from "./security-headers.ts";

const CONTEXT_ID = "client.context.post";
const found = ROUTES.find((route) => route.id === CONTEXT_ID);
if (found === undefined) throw new Error(`no contract ${CONTEXT_ID}`);
const contract = found;

export const CLIENT_CONTEXT_MAX_BYTES = contract.request.maxBodyBytes ?? 256;
export const CLIENT_CONTEXT_TIMEOUT_MS = 5_000;

type Lists = typeof CLIENT_CONTEXT_VALUES;
export type ClientContext = { readonly [K in keyof Lists]: Lists[K][number] } & {
  readonly appVersion: string;
};
export type ClientContextParse =
  | { readonly ok: true; readonly value: ClientContext }
  | { readonly ok: false; readonly code: "invalid_json" | "invalid_input" };

const VERSION_RE = new RegExp(CLIENT_APP_VERSION_PATTERN, "u");
const LIST_FIELDS = Object.keys(CLIENT_CONTEXT_VALUES) as (keyof Lists)[];
/** Every field, in JCS (code point) order. */
const FIELDS = [...LIST_FIELDS, "appVersion"].sort();
const INVALID_INPUT: ClientContextParse = { ok: false, code: "invalid_input" };

/**
 * The context from the exact JCS bytes of the closed body. Strict UTF-8 (a
 * byte order mark stays a character) and JSON.parse, or invalid_json. Then
 * exactly the six own keys, each a string on its closed list (an array's
 * includes: nothing inherited matches), and the bytes must equal the JCS
 * text of the value, which refuses a duplicate key, white space, escapes and
 * another key order. Anything else is invalid_input.
 */
export function parseClientContext(bytes: Uint8Array): ClientContextParse {
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
    const list: readonly unknown[] = CLIENT_CONTEXT_VALUES[field];
    if (typeof record[field] !== "string" || !list.includes(record[field])) return INVALID_INPUT;
  }
  // Every value is a plain ASCII word here, so JSON.stringify of each is its JCS form.
  const canonical = `{${FIELDS.map((key) => `"${key}":${JSON.stringify(record[key])}`).join(",")}}`;
  if (canonical !== text) return INVALID_INPUT;
  const context = Object.fromEntries(FIELDS.map((key) => [key, record[key]]));
  return { ok: true, value: Object.freeze(context) as ClientContext };
}

export type ClientContextOptions = {
  /** The log service; without it the route checks and answers but records nothing. */
  readonly log?: LogWriter;
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

/** Hands the record to the log without waiting; a throw or rejection is dropped. */
function record(log: LogWriter, input: unknown): void {
  void Promise.resolve()
    .then(() => log(input))
    .catch(() => undefined);
}

export function createClientContextRoute(options: ClientContextOptions = {}): Route {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? CLIENT_CONTEXT_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(request, CLIENT_CONTEXT_MAX_BYTES, timeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      const parsed = parseClientContext(body.bytes);
      if (!parsed.ok) return sendProblem(response, 400, parsed.code);
      if (options.log !== undefined) {
        record(options.log, {
          time: now().toISOString(),
          event: "client.context_reported",
          requestId: requestIdOf(response),
          accountKind: "anonymous",
          fields: parsed.value,
        });
      }
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    },
  };
}
