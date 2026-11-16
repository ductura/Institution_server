// Origin guard for a state-changing request (docs/server-map.md §3, step 7;
// ARCHITECTURE §4 t. 4). Port of checkMutationRequest from Ductus
// src/server/http/mutation-request.ts at d52a92c3. Changes: it runs as a layer
// before the router on IncomingMessage, so it does not check the route's
// method (the router answers 405); every method but GET, HEAD and OPTIONS is
// state-changing, an unknown name included; a header sent twice is refused
// instead of being read joined by a comma; no configured origin refuses every
// such request. The check never reads the body.
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ErrorSpec, ROUTES } from "../contracts/index.ts";

import { failureHtml } from "./auth-flow.ts";
import { sendHtmlProblem } from "./problem.ts";
import { routePath } from "./router.ts";
import { applySecurityHeaders, refuse } from "./security-headers.ts";

/** An allow-list: any other method name is state-changing. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Codes of server/contracts (403). */
export type OriginRefusal = "origin_missing" | "origin_mismatch" | "cross_site";
export type OriginCheck = { ok: true } | { ok: false; status: 403; reason: OriginRefusal };

const OK: OriginCheck = { ok: true };
const refused = (reason: OriginRefusal): OriginCheck => ({ ok: false, status: 403, reason });

/**
 * A state-changing request passes only with exactly one Origin equal to the
 * expected origin, and with Sec-Fetch-Site absent or exactly once
 * "same-origin" (a same-site subdomain is another origin). The comparison is
 * exact: browsers send the canonical form.
 */
export function checkMutationRequest(
  request: IncomingMessage,
  expectedOrigin: string | null,
): OriginCheck {
  if (SAFE_METHODS.has(request.method ?? "")) return OK;
  const headers = request.headersDistinct;
  const origins = headers.origin ?? [];
  if (origins.length > 1) return refused("origin_mismatch");
  const origin = origins[0];
  if (origin === undefined || origin === "" || origin === "null") return refused("origin_missing");
  if (expectedOrigin === null || origin !== expectedOrigin) return refused("origin_mismatch");
  const sites = headers["sec-fetch-site"];
  if (sites !== undefined && (sites.length !== 1 || sites[0] !== "same-origin")) {
    return refused("cross_site");
  }
  return OK;
}

/** A bare scheme://host[:port] of http or https, exactly as URL prints it. */
export function isCanonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * The routes whose contract answers 403 with a page (a browser navigation,
 * such as auth.logout-all.post): by method and path, as the router chooses.
 */
const HTML_REFUSALS: ReadonlyMap<string, ErrorSpec> = new Map(
  ROUTES.flatMap((route) => {
    const spec = route.errors.find((error) => error.status === 403 && error.body === "html");
    return spec === undefined ? [] : [[`${route.method} ${route.path}`, spec] as const];
  }),
);

/**
 * Routes the identity provider calls server to server (contract access
 * "identity_provider", the back-channel logout): no Origin is sent and no
 * cookie is read; the signed token is the proof (S-1D-d, DAN-829-3). Ductus
 * checked origin per route and never on this one.
 */
const PROVIDER_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.access === "identity_provider").map(
    (route) => `${route.method} ${route.path}`,
  ),
);

/** Step 7 of the pipeline; null refuses every state-changing request. */
export function originLayer(
  expectedOrigin: string | null,
): (request: IncomingMessage, response: ServerResponse) => Promise<"next" | "done"> {
  // A misconfigured origin must fail loudly, never match anything.
  if (expectedOrigin !== null && !isCanonicalOrigin(expectedOrigin)) {
    throw new Error("expected origin must be a bare scheme://host[:port]");
  }
  return async (request, response) => {
    if (PROVIDER_ROUTES.has(`${request.method ?? ""} ${routePath(request.url) ?? ""}`)) {
      return "next";
    }
    const check = checkMutationRequest(request, expectedOrigin);
    if (check.ok) return "next";
    // A navigation route's contract gives its own page (vector "forbidden",
    // QA on #155); every other route gets the problem of the reason.
    const page = HTML_REFUSALS.get(`${request.method ?? ""} ${routePath(request.url) ?? ""}`);
    if (page === undefined) {
      refuse(response, check.status, check.reason);
      return "done";
    }
    applySecurityHeaders(response);
    if (!response.headersSent) response.setHeader("Connection", "close");
    sendHtmlProblem(response, page, failureHtml(403));
    return "done";
  };
}

// Reading a state-changing body (docs/server-map.md §3, step 9): port of
// readBodyWithLimit and declaredLengthRefusal from Ductus
// src/server/http/mutation-request.ts at d52a92c3 (PR #213), on
// IncomingMessage instead of a Web Request. The body is read as raw bytes
// with a hard byte limit before anything parses it, and never decoded here.
// Ductus cancels the stream on a refusal; here reading stops (pause) and the
// refusal closes the connection (refuse()), so the rest is never read.

export type LimitedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 413; reason: "body_too_large" }
  | { ok: false; status: 408; reason: "body_timeout" }
  | {
      ok: false;
      status: 400;
      reason: "content_length_invalid" | "content_length_mismatch" | "body_stream_error";
    };

// Stricter than RFC 9112 on purpose, as in Ductus: no leading zeros.
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;

/**
 * What readBodyWithLimit refuses from the declared Content-Length alone,
 * before a byte is read: a malformed length is 400, a length over maxBytes is
 * 413, anything else (no header included) is null.
 */
export function declaredLengthRefusal(
  request: IncomingMessage,
  maxBytes: number,
): 400 | 413 | null {
  const header = request.headers["content-length"];
  if (header === undefined) return null;
  if (!DECIMAL.test(header)) return 400;
  return Number(header) > maxBytes ? 413 : null;
}

const refusedBody = {
  invalid: { ok: false, status: 400, reason: "content_length_invalid" },
  mismatch: { ok: false, status: 400, reason: "content_length_mismatch" },
  stream: { ok: false, status: 400, reason: "body_stream_error" },
  large: { ok: false, status: 413, reason: "body_too_large" },
  timeout: { ok: false, status: 408, reason: "body_timeout" },
} as const satisfies Record<string, LimitedBodyResult>;

/**
 * Reads the body as raw bytes, at most maxBytes. A declared Content-Length
 * over the limit is refused without reading; an undeclared (chunked) body is
 * cut off at the first chunk past the limit. A body that fails mid-read
 * (client gone) or was already read is body_stream_error, never a throw, and
 * no partial bytes leave this function. There is no default time limit: a
 * route that accepts a streamed body passes timeoutMs, an absolute deadline.
 */
// setTimeout fires at once above this (TimeoutOverflowWarning).
const MAX_TIMEOUT_MS = 2_147_483_647;
const INITIAL_CAPACITY = 16 * 1024;
// One reader per request: a second call, even a concurrent one, gets nothing.
const read = new WeakSet<IncomingMessage>();

export async function readBodyWithLimit(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs?: number,
): Promise<LimitedBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error("timeoutMs must be a positive integer of at most 2^31-1");
  }
  if (read.has(request)) return refusedBody.stream;
  read.add(request);
  // A late error of a request this function stopped reading must not crash.
  request.on("error", () => undefined);
  const refusal = declaredLengthRefusal(request, maxBytes);
  if (refusal !== null) {
    request.pause();
    return refusal === 400 ? refusedBody.invalid : refusedBody.large;
  }
  if (request.readableEnded || request.destroyed || request.readableDidRead) {
    return refusedBody.stream;
  }
  const header = request.headers["content-length"];
  const declared = header === undefined ? null : Number(header);

  return new Promise((resolve) => {
    // Each chunk is copied into one buffer and dropped: a kept chunk would
    // keep its whole socket read buffer alive, so many tiny chunks would cost
    // far more memory than maxBytes (adversarial pass on 74ced6c).
    let buffer = Buffer.alloc(declared ?? Math.min(INITIAL_CAPACITY, maxBytes));
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: LimitedBodyResult): void => {
      if (timer !== undefined) clearTimeout(timer);
      request.off("data", onData).off("end", onEnd).off("error", onFail).off("close", onFail);
      if (!result.ok) request.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      const next = size + chunk.byteLength;
      if (next > maxBytes) {
        finish(refusedBody.large);
        return;
      }
      if (next > buffer.byteLength) {
        const grown = Buffer.alloc(Math.min(maxBytes, Math.max(next, buffer.byteLength * 2)));
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      chunk.copy(buffer, size);
      size = next;
    };
    const onEnd = (): void => {
      if (declared !== null && declared !== size) finish(refusedBody.mismatch);
      else finish({ ok: true, bytes: new Uint8Array(buffer.subarray(0, size)) });
    };
    // "close" before "end" is a body the client never finished.
    const onFail = (): void => finish(refusedBody.stream);
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(refusedBody.timeout), timeoutMs);
    request.on("data", onData).on("end", onEnd).on("error", onFail).on("close", onFail);
    // A request someone paused earlier would otherwise never flow.
    request.resume();
  });
}
