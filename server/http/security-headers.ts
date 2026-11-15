// The security headers of every response (docs/server-map.md §3, step 6).
// Port of Ductus src/server/http/security-headers.ts at d52a92c3 (DAN-296,
// DAN-489): the same values, plus the API policy of
// content-security-policy.ts and no-store. Ductus wraps
// ServerResponse.prototype.writeHead because Next.js answers some requests
// before its config runs; here every answer goes through the pipeline, so the
// layer sets the headers and refuse() carries them on refusals of the steps
// before it (3 to 5).
import { type IncomingMessage, type ServerResponse, STATUS_CODES } from "node:http";

import { INTERNAL } from "../contracts/index.ts";

import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";

export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] =
  Object.freeze([
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Ignored over plain http (RFC 6797 §8.1); it acts behind TLS.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=(), clipboard-write=(self)",
    },
    // API responses carry no markup to run; nothing may load from them.
    {
      key: "Content-Security-Policy",
      value: "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
    { key: "Cache-Control", value: "no-store" },
  ]);

/** Sets each header the response does not have yet; a route's own value stays. */
export function applySecurityHeaders(response: ServerResponse): void {
  if (response.headersSent) return;
  for (const { key, value } of SECURITY_HEADERS) {
    if (!response.hasHeader(key)) response.setHeader(key, value);
  }
}

/** Step 6 of the pipeline. */
export async function securityHeadersLayer(
  _request: IncomingMessage,
  response: ServerResponse,
): Promise<"next"> {
  applySecurityHeaders(response);
  return "next";
}

/**
 * The one way a layer refuses: the contract's problem body (problem.ts) with
 * the security headers, whichever step refuses. The connection closes after it, so Node does not read and discard
 * an unread body of any size to keep the connection alive.
 */
export function refuse(response: ServerResponse, status: number, code: string): void {
  applySecurityHeaders(response);
  if (!response.headersSent) response.setHeader("Connection", "close");
  sendProblem(response, status, code);
}

/**
 * The contract's 500 for a failed request (DAN-776), the problem of INTERNAL. Before
 * the head, whatever the failed handler or layer set (headers, trailers, status line)
 * is dropped, so nothing of it reaches the client; the security headers are set
 * again and the connection closes. After the head an unfinished answer is cut
 * and a finished one is left to complete. Never throws: a failure here cuts
 * the connection instead of reaching the process as an unhandled rejection.
 */
export function answerInternal(response: ServerResponse): void {
  try {
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    for (const name of response.getHeaderNames()) response.removeHeader(name);
    // Trailers are kept apart from the headers; adding none clears them.
    response.addTrailers({});
    response.statusMessage = STATUS_CODES[INTERNAL.error.status] ?? "";
    applySecurityHeaders(response);
    // The same id again: the headers above were dropped with the failed answer's.
    requestIdOf(response);
    response.setHeader("Connection", "close");
    sendProblem(response, INTERNAL.error.status, INTERNAL.error.code);
  } catch {
    response.destroy();
  }
}
