import type { ActorReader } from "../database/index.ts";

import { sessionPrincipal } from "./principal.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * What the session step of an evidence route decides (DAN-805):
 * - `unauthenticated`: no token, a malformed one, or, when asked, a session
 *   the database reports closed, expired, idle or unknown;
 * - `context`: the database could not be asked; never read as signed out.
 */
export type SessionCheck =
  | { ok: true; token: string; verified: boolean }
  | { ok: false; refusal: "unauthenticated" | "context" };

/**
 * With `live`, the session is asked of the database through `app.current_actor()`
 * (the ActorReader port; the token is only presented, the person never comes
 * from the request). Without it only the form is checked and the route's own
 * function decides, as `open` does in Ductus. `verified` says which happened.
 */
export async function checkSession(
  token: string | undefined,
  actors: ActorReader,
  options: { live: boolean },
): Promise<SessionCheck> {
  if (token === undefined || !TOKEN.test(token)) return { ok: false, refusal: "unauthenticated" };
  if (!options.live) return { ok: true, token, verified: false };
  let principal;
  try {
    principal = await sessionPrincipal(token, actors);
  } catch {
    return { ok: false, refusal: "context" };
  }
  if (principal.kind === "signed-in") return { ok: true, token, verified: true };
  if (principal.kind === "signed-out") return { ok: false, refusal: "unauthenticated" };
  return { ok: false, refusal: "context" };
}
