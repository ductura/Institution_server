import { TOO_MANY_REQUESTS } from "../../contracts/index.ts";
import { type ActorReader, sessionPrincipal, sessionTokenFromCookie } from "../../session/index.ts";
import { classOf, createRateLimiter, type RateLimits } from "../../traffic/index.ts";
import { createRateLimitLog, refuse, type Route } from "../index.ts";
import { needsIdleCheck } from "../security/index.ts";

export { readRateLimitConfig } from "./config.ts";

const WINDOW_MS = 60_000;
const MAX_WINDOWS = 50_000;

/** The existing early IP check, with account limits enforced on matched routes. */
export function createAddressRateLimiter(limits: RateLimits, now = Date.now) {
  return createRateLimiter({ limits, now, sessionTokenOf: () => undefined });
}

type AccountWindow = { readonly expiresAt: number; count: number };

/** Uses the router's operation ID so path parameters and query strings share a quota. */
export function createAccountRateLimiter(
  limits: RateLimits,
  actors: ActorReader,
  now = () => performance.now(),
) {
  const windows = new Map<string, AccountWindow>();
  const log = createRateLimitLog();
  const retryAfter = (remainingMs: number) => Math.max(1, Math.ceil(remainingMs / 1000));

  function take(key: string, limit: number): number | undefined {
    const at = now();
    for (const [oldKey, oldWindow] of windows) {
      if (oldWindow.expiresAt > at) break;
      windows.delete(oldKey);
    }
    const active = windows.get(key);
    if (active !== undefined) {
      if (active.count >= limit) return retryAfter(active.expiresAt - at);
      active.count += 1;
      return;
    }
    // At capacity, keep active quotas until expiry instead of resetting one early.
    const oldest = windows.values().next().value;
    if (windows.size >= MAX_WINDOWS && oldest !== undefined)
      return retryAfter(oldest.expiresAt - at);
    windows.set(key, { expiresAt: at + WINDOW_MS, count: 1 });
  }

  function limitRoute(route: Route): Route {
    const { contract, handle } = route;
    const limit = limits[classOf(contract.method, contract.path)].perAccount;
    if (!needsIdleCheck(contract) || limit === null) return route;
    return {
      contract,
      async handle(request, response, params) {
        const token = sessionTokenFromCookie(request.headers.cookie);
        const actor = await sessionPrincipal(token, actors);
        if (actor.kind === "unverified") return refuse(response, 503, "unavailable");
        if (actor.kind === "signed-in") {
          // Synchronous after identity lookup, including under concurrent requests.
          const retry = take(`${contract.id} ${actor.scope}`, limit);
          if (retry !== undefined) {
            log({ route: contract.path, bucket: "per_account" });
            response.setHeader("Retry-After", String(retry));
            const { status, code } = TOO_MANY_REQUESTS.error;
            return refuse(response, status, code);
          }
        }
        return handle(request, response, params);
      },
    };
  }

  return (routes: readonly Route[]): Route[] => routes.map(limitRoute);
}
