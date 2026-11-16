// Step 4 of the pipeline (docs/server-map.md §3): the rate limit of
// server/traffic (S-1C.3, DAN-814 b; contract Ductus#1836 c.6908215789,
// attack plan ductura/server#117). A refusal is the shared contract error
// 429 too_many_requests with Retry-After, through refuse(), so the
// connection closes and nothing pipelined behind it runs (N13). The limiter
// reads the session token as server/session does (self-attack B1 on part a).
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES, TOO_MANY_REQUESTS } from "../contracts/index.ts";
import { logEvent } from "../log/index.ts";
import { sessionTokenFromCookie } from "../session/index.ts";
import { createRateLimiter, type RateLimiter } from "../traffic/index.ts";

import { routePath } from "./router.ts";
import { refuse } from "./security-headers.ts";

/** The record of a refusal: the route only when it is a contract path, never IP or cookie (N16). */
export type RateLimitLog = (fields: {
  readonly route?: string;
  readonly bucket: "per_address" | "per_account";
}) => void;

const PATHS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.path));

const defaultLog: RateLimitLog = (fields) => logEvent("warn", "traffic.rate_limited", fields);

/** The limiter with the catalogue's defaults and the session's own reading of the cookie. */
export function defaultRateLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({
    sessionTokenOf: (request) => sessionTokenFromCookie(request.headers.cookie),
    ...(now === undefined ? {} : { now }),
  });
}

export function rateLimitLayer(limiter: RateLimiter, log: RateLimitLog = defaultLog) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<"next" | "done"> => {
    const decision = limiter.check(request);
    if (decision.allowed) return "next";
    const path = routePath(request.url);
    try {
      log({
        ...(path !== undefined && PATHS.has(path) ? { route: path } : {}),
        bucket: decision.bucket,
      });
    } catch {
      // A failed record never changes the answer.
    }
    if (!response.headersSent) response.setHeader("Retry-After", String(decision.retryAfter));
    refuse(response, TOO_MANY_REQUESTS.error.status, TOO_MANY_REQUESTS.error.code);
    return "done";
  };
}
