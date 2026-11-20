import { createHash, createHmac } from "node:crypto";

import type { ActorReader } from "../database/index.ts";

/**
 * Who the session cookie belongs to, as far as the browser's local journal is
 * concerned (F-5, plan #376 critical contract 1). The identity comes from the
 * database, through `app.current_actor()` read by the ActorReader port of
 * server/database, never from the request: the cookie is only presented.
 *
 * - `signed-in`: an open, unexpired session. `scope` names the IndexedDB
 *   journal of that person and institution and nothing else.
 * - `signed-out`: no cookie, a malformed one, or a session that is closed or
 *   expired. Nothing is shown as signed in.
 * - `unverified`: a well-formed cookie the database could not be asked about.
 *   The page must not guess either way, so it offers no journal at all.
 */
export type SessionPrincipal =
  { kind: "signed-in"; scope: string } | { kind: "signed-out" } | { kind: "unverified" };

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Plain-text label the scope digest is derived from; versioned on purpose and
 * different from the local demo label, so no principal's journal is ever the
 * demo journal (src/lib/journal/local-scope.ts).
 */
export const PRINCIPAL_SCOPE_LABEL = "ductus-principal-journal-v1";

/**
 * SHA-256 hex of the label, the institution and the user. The digest names a
 * database; it is not a secret and reveals neither id on its own.
 */
export function principalScope(userId: string, institutionId: string): string {
  return createHash("sha256")
    .update(`${PRINCIPAL_SCOPE_LABEL}\n${institutionId}\n${userId}`, "utf8")
    .digest("hex");
}

/** Plain-text label of the session tag; never the database's token digest. */
export const SESSION_TAG_LABEL = "ductus-session-tag-v1";

/**
 * Which cookie a page was rendered under, for the tabs of one browser (F-5,
 * D-118; src/client/session-marks.ts): a SHA-256 hex of the label and the
 * token, or null without a well-formed cookie. It says nothing about whether
 * the session is open, and it is not the digest the database keeps.
 */
export function sessionTag(token: string | undefined): string | null {
  if (token === undefined || !TOKEN_FORMAT.test(token)) return null;
  return createHash("sha256").update(`${SESSION_TAG_LABEL}\n${token}`, "utf8").digest("hex");
}

/**
 * Domain label of the session tag that profile.me.get sends (SRV-ST, Ductus#2028
 * c.7023897577). Other than SESSION_TAG_LABEL, so the value never names an
 * ended mark cookie.
 */
export const ACCOUNT_SESSION_TAG_LABEL = "ductura-session-tag-v1";

/**
 * The opaque tag of one login, for GET /api/v1/me: HMAC-SHA-256 hex
 * (lowercase) keyed by the domain label over the session token. The token is
 * fixed for the life of a session row (identity.session.token_hash is unique
 * and never rotates), so the same session has the same tag and every new login
 * has another, for the same person too. The token is 256 random bits, so the
 * tag reveals neither it nor the database's token digest; the internal session
 * id, the person and the institution are not inputs at all.
 */
export function accountSessionTag(token: string): string {
  if (!TOKEN_FORMAT.test(token)) throw new Error("accountSessionTag: malformed token");
  return createHmac("sha256", ACCOUNT_SESSION_TAG_LABEL).update(token, "utf8").digest("hex");
}

/** One port call; null on an error the caller turns into `unverified`. */
async function readActor<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    // Only the error's name: never the token, a statement or a message.
    console.error("session check failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

export async function sessionPrincipal(
  token: string | undefined,
  actors: ActorReader,
): Promise<SessionPrincipal> {
  if (token === undefined || !TOKEN_FORMAT.test(token)) return { kind: "signed-out" };
  const actor = await readActor(() => actors.currentActor(token));
  if (actor === null) return { kind: "unverified" };
  if (!actor.userId || !actor.institutionId) return { kind: "signed-out" };
  return { kind: "signed-in", scope: principalScope(actor.userId, actor.institutionId) };
}

/** As `SessionPrincipal`, and a signed-in one also names the slug of its institution. */
export type SessionPrincipalWithInstitution =
  | { kind: "signed-in"; scope: string; institution: string | null }
  | { kind: "signed-out" }
  | { kind: "unverified" };

/**
 * `sessionPrincipal` plus the slug of the session's institution, whose record
 * gives the citation style (M2.12-P02, plan #1689 C1 to C7). Person and slug
 * come from the same statement and transaction (server/database
 * current-actor.ts), so a session closed in between yields neither, and an
 * institution never comes from the request.
 */
export async function sessionPrincipalWithInstitution(
  token: string | undefined,
  actors: ActorReader,
): Promise<SessionPrincipalWithInstitution> {
  if (token === undefined || !TOKEN_FORMAT.test(token)) return { kind: "signed-out" };
  const actor = await readActor(() => actors.currentActorWithInstitution(token));
  if (actor === null) return { kind: "unverified" };
  if (!actor.userId || !actor.institutionId) return { kind: "signed-out" };
  return {
    kind: "signed-in",
    scope: principalScope(actor.userId, actor.institutionId),
    institution: actor.institutionSlug,
  };
}
