// Idle expiry on the routes that need a session (SRV-1401, DAN-296, M1.6). A
// session idle longer than its institution's limit gets 401
// session_idle_expired before its handler runs; an accepted answer (status
// below 400) extends it. The rule itself is server/identity (createIdleTracker).
import { SESSION_IDLE_EXPIRED, type RouteContract } from "../../contracts/index.ts";
import type { IdleTracker } from "../../identity/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { refuse, type Handler, type Route } from "../index.ts";

/**
 * Routes a session reaches without the idle check: signing out must still end
 * an idle session in the database and clear its cookie.
 */
export const IDLE_EXEMPT_ROUTE_IDS: readonly string[] = Object.freeze([
  "auth.logout.post",
  "auth.logout-all.post",
]);

/** Whether a route is idle-checked: it needs a session and is not a sign-out. */
export function needsIdleCheck(contract: Pick<RouteContract, "id" | "access">): boolean {
  return (
    contract.access !== "anyone" &&
    contract.access !== "identity_provider" &&
    !IDLE_EXEMPT_ROUTE_IDS.includes(contract.id)
  );
}

function guarded(handle: Handler, tracker: IdleTracker): Handler {
  return async (request, response, params) => {
    // No live session cookie: nothing to check, the route answers 401 itself.
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) return handle(request, response, params);
    if ((await tracker.check(token)) === "expired") {
      // refuse closes the connection, so an unread body is never read.
      const { status, code } = SESSION_IDLE_EXPIRED.error;
      return refuse(response, status, code);
    }
    await handle(request, response, params);
    // Only an accepted answer counts: a token the database refuses gets no entry.
    if (response.statusCode < 400) tracker.touch(token);
  };
}

/** The routes with the idle check on each route that needs it; the rest unchanged. */
export function guardIdleSessions(routes: readonly Route[], tracker: IdleTracker): Route[] {
  return routes.map((route) =>
    needsIdleCheck(route.contract)
      ? { contract: route.contract, handle: guarded(route.handle, tracker) }
      : route,
  );
}
