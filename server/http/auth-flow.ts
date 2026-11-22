/**
 * The login and callback routes (B-6; docs/BACKEND.md 4.3), as plain Request
 * to Response functions so tests drive them without a server; the HTTP
 * routes over them come in the second PR of S-1E-a. Every failure ends on one neutral Croatian page: the
 * browser learns neither which check failed nor whether an institution
 * exists. Logs carry a stage and an error code, never a value from the
 * request or the provider. Ported from Ductus src/server/auth/flow.ts at
 * 078c780 (S-1E-a, DAN-808); logout-all (S-1D-c, DAN-828-1) from 333e163;
 * logout (S-1D-d, DAN-829-1) from 393b8e0.
 */
import { messagesHr as t } from "../../locales/index.ts";
import {
  identityFromClaims,
  isProviderUnavailable,
  newLoginChecks,
  type AuthConfig,
  type LoginChecks,
  type OidcClient,
} from "../external/srce-auth/index.ts";

import type { OpenSession } from "../database/index.ts";
import {
  clearedSessionSetCookie,
  DEFAULT_RETURN_TO,
  newSessionToken,
  previousSessionToken,
  safeReturnTo,
  sessionSetCookie,
} from "../session/index.ts";

export type AuthDeps = {
  config: AuthConfig;
  oidc: OidcClient;
  openSession: OpenSession;
  /** Closes the session behind a raw cookie token; false when there was none. */
  closeSession: (token: string) => Promise<boolean>;
  /**
   * Closes every live session of the account behind a raw cookie token, this
   * one included (DAN-296); nothing when the token names no live session.
   */
  closeAllSessions: (token: string) => Promise<void>;
};

/** The pending login attempt: state, nonce, PKCE verifier and where to go after. */
export const LOGIN_COOKIE_NAME = "__Host-ductus_login";
const LOGIN_COOKIE_MAX_AGE = 600;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
/** The longest attempt cookie value finishLogin reads. */
const MAX_ATTEMPT_CHARS = 1024;

/** Where the neutral page sends a new attempt (the contract path of auth.login.get). */
export const LOGIN_PATH = "/api/v1/auth/login";

/**
 * The mark of an explicit sign-out (INT-20b): logout and logout-all set it,
 * and the next login asks the provider for `prompt=login`, so the provider
 * signs the person in again even if its own session outlived the sign-out.
 * `__Secure-` and not `__Host-`, as it is sent to the auth routes alone; the
 * value is a constant and says nothing of the person.
 */
export const SIGNED_OUT_COOKIE_NAME = "__Secure-ductus_signed_out";
const SIGNED_OUT_VALUE = "1";
const SIGNED_OUT_COOKIE_MAX_AGE = 300;
const AUTH_ROUTES_PATH = "/api/v1/auth";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function cookie(name: string, value: string, attributes: string): string {
  // __Host-: Secure, Path=/ and no Domain, so the cookie belongs to this host alone.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; ${attributes}`;
}

function signedOutCookie(value: string, attributes: string): string {
  return `${SIGNED_OUT_COOKIE_NAME}=${value}; Path=${AUTH_ROUTES_PATH}; HttpOnly; Secure; SameSite=Lax; ${attributes}`;
}

/** The Set-Cookie of the sign-out mark. */
export const signedOutSetCookie = () =>
  signedOutCookie(SIGNED_OUT_VALUE, `Max-Age=${SIGNED_OUT_COOKIE_MAX_AGE}`);
/** The Set-Cookie that drops the sign-out mark. */
export const clearedSignedOutSetCookie = () => signedOutCookie("", "Max-Age=0");

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

type Attempt = LoginChecks & {
  returnTo: string;
  /**
   * Set only for an attempt started with the sign-out mark (INT-20d): the
   * second the attempt started. Its callback then needs an ID token whose
   * `auth_time` is not before it (within the clock tolerance). An attempt
   * without the mark carries no such field and is read as before.
   */
  freshSince?: number;
};

function encodeAttempt(attempt: Attempt): string {
  return Buffer.from(JSON.stringify({ v: 1, ...attempt })).toString("base64url");
}

/** A whole number of seconds since the epoch, as `auth_time` and `iat` are. */
const isEpochSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// The cookie is not signed: it is __Host- and HttpOnly, so whoever can write
// it already controls this origin. It is still parsed as untrusted input.
function decodeAttempt(value: string | undefined): Attempt | undefined {
  if (!value || value.length > MAX_ATTEMPT_CHARS) return undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { v, state, nonce, codeVerifier, returnTo, freshSince } = raw as Record<string, unknown>;
    if (v !== 1) return undefined;
    for (const random of [state, nonce, codeVerifier]) {
      if (typeof random !== "string" || !RANDOM_VALUE.test(random)) return undefined;
    }
    if (freshSince !== undefined && !isEpochSeconds(freshSince)) return undefined;
    return {
      state: state as string,
      nonce: nonce as string,
      codeVerifier: codeVerifier as string,
      returnTo: safeReturnTo(returnTo),
      ...(freshSince === undefined ? {} : { freshSince }),
    };
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}:${code}` : error.name;
  }
  return "unknown";
}

function logFailure(stage: string, detail: string): void {
  console.error("login failed", stage, detail);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The HTML of the neutral page; step 7 of the pipeline answers a refused origin with it too. */
export function failureHtml(status: 400 | 403 | 503): string {
  const body = status === 503 ? t.auth.unavailableBody : t.auth.failedBody;
  return `<!doctype html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.auth.failedTitle)} · ${escapeHtml(t.app.name)}</title></head>
<body><main><h1>${escapeHtml(t.auth.failedTitle)}</h1><p>${escapeHtml(body)}</p>
<p><a href="${LOGIN_PATH}">${escapeHtml(t.auth.retry)}</a> · <a href="/">${escapeHtml(t.auth.home)}</a></p></main></body></html>`;
}

/** The neutral page every failure ends on. */
export function failurePage(
  status: 400 | 403 | 503,
  extraHeaders: Headers = new Headers(),
): Response {
  const html = failureHtml(status);
  const headers = new Headers(extraHeaders);
  for (const [k, v] of Object.entries(NO_STORE)) headers.set(k, v);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status, headers });
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * Why `auth_time` does not show a sign-in at the provider made at or after
 * `sinceSeconds` (INT-20d), or undefined when it does: it must be present, a
 * whole number of seconds, not earlier than that less the allowed clock skew
 * ("stale"), and not later than this clock plus the same skew ("future",
 * INT-20e), as `iat` is bounded by `issuedWithinSkew`.
 */
export function authTimeRefusal(
  authTime: unknown,
  sinceSeconds: number,
  toleranceSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): "missing" | "stale" | "future" | undefined {
  // "missing" also covers a value that is no time at all.
  if (!isEpochSeconds(authTime)) return "missing";
  if (authTime < sinceSeconds - toleranceSeconds) return "stale";
  if (authTime > nowSeconds + toleranceSeconds) return "future";
  return undefined;
}

/** GET /api/v1/auth/login?returnTo=/path */
export async function startLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const checks = newLoginChecks();
  // After an explicit sign-out the provider is asked to sign in again. The
  // mark stays until a login succeeds, so an abandoned attempt does not
  // spend it. `max_age=0` (INT-20d) makes the provider report when the
  // person signed in, and the attempt keeps its start to compare (finishLogin).
  const signedOut = readCookie(request, SIGNED_OUT_COOKIE_NAME) === SIGNED_OUT_VALUE;
  const fresh = signedOut ? { freshSince: Math.floor(Date.now() / 1000) } : {};
  let location: URL;
  try {
    location = await deps.oidc.authorizationUrl(
      checks,
      signedOut ? { prompt: "login", maxAge: 0 } : {},
    );
  } catch (error) {
    logFailure("authorize", errorCode(error));
    return failurePage(503);
  }
  // A return path that normalizes past the decoder's limit (a long
  // non-ASCII path, percent-encoded by URL) would give an attempt that
  // finishLogin refuses; such an attempt returns to the default page instead
  // (Codex on #104; the same gap is in Ductus flow.ts at 078c780).
  let attempt = encodeAttempt({ ...checks, returnTo, ...fresh });
  if (attempt.length > MAX_ATTEMPT_CHARS) {
    attempt = encodeAttempt({ ...checks, returnTo: DEFAULT_RETURN_TO, ...fresh });
  }
  return redirect(location.href, [
    cookie(LOGIN_COOKIE_NAME, attempt, `Max-Age=${LOGIN_COOKIE_MAX_AGE}`),
  ]);
}

const clearedLoginCookie = () => cookie(LOGIN_COOKIE_NAME, "", "Max-Age=0");

/** GET /api/v1/auth/callback?code=…&state=… */
export async function finishLogin(request: Request, deps: AuthDeps): Promise<Response> {
  // The attempt is single use: whatever happens next, its cookie is cleared,
  // so a replayed callback finds no state to match.
  const cleared = new Headers({ "set-cookie": clearedLoginCookie() });
  const attempt = decodeAttempt(readCookie(request, LOGIN_COOKIE_NAME));
  if (!attempt) {
    logFailure("callback", "no_attempt");
    return failurePage(400, cleared);
  }
  // While the sign-out mark is there, only an attempt started with it counts
  // (INT-20e): an attempt without its start is refused before the provider
  // is asked, and the mark stays for the next attempt.
  const signedOut = readCookie(request, SIGNED_OUT_COOKIE_NAME) === SIGNED_OUT_VALUE;
  if (signedOut && attempt.freshSince === undefined) {
    logFailure("callback", "attempt_without_start");
    return failurePage(400, cleared);
  }

  let verified;
  try {
    verified = await deps.oidc.verify(new URL(request.url), attempt);
  } catch (error) {
    logFailure("verify", errorCode(error));
    return failurePage(isProviderUnavailable(error) ? 503 : 400, cleared);
  }

  // An attempt started after a sign-out (INT-20d) counts only a sign-in at
  // the provider made after the attempt began and not after now; the
  // sign-out mark stays when it fails.
  if (attempt.freshSince !== undefined) {
    const refusal = authTimeRefusal(
      verified.idToken.auth_time,
      attempt.freshSince,
      deps.config.clockToleranceSeconds,
    );
    if (refusal) {
      logFailure("auth_time", refusal);
      return failurePage(400, cleared);
    }
  }

  const claims = identityFromClaims(verified.idToken, verified.userinfo);
  if (!claims.ok) {
    logFailure("claims", claims.reason);
    return failurePage(403, cleared);
  }

  const { token, tokenHash } = newSessionToken();
  let opened;
  try {
    opened = await deps.openSession({ issuer: verified.issuer, ...claims.identity, tokenHash });
  } catch (error) {
    logFailure("open_session", errorCode(error));
    return failurePage(503, cleared);
  }
  if (!opened.ok) {
    logFailure("open_session", opened.reason);
    return failurePage(opened.reason === "refused" ? 403 : 400, cleared);
  }

  // A session cookie the browser already had (another user's, or one planted
  // before login) is closed, never reused: the new session has a new token.
  const previous = previousSessionToken(request.headers.get("cookie"));
  if (previous) {
    await deps
      .closeSession(previous)
      .catch((error: unknown) => logFailure("close_previous", errorCode(error)));
  }

  return redirect(new URL(attempt.returnTo, deps.config.redirectUri.origin).href, [
    clearedLoginCookie(),
    sessionSetCookie(token, opened.expires),
    // The sign-out mark has done its work once an attempt started with it
    // succeeded (INT-20e); a failed callback keeps it for the next attempt.
    ...(attempt.freshSince !== undefined &&
    readCookie(request, SIGNED_OUT_COOKIE_NAME) !== undefined
      ? [clearedSignedOutSetCookie()]
      : []),
  ]);
}

/**
 * The request comes from a page of this origin (DAN-302 L2): Origin is
 * required and must be this origin, and Sec-Fetch-Site, when sent, must say
 * same-origin. Step 7 of the pipeline checks the same first; this is the
 * flow's own second check, as in Ductus.
 */
export function isSameOrigin(request: Request, origin: string): boolean {
  if (request.headers.get("origin") !== origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** POST /api/v1/auth/logout: this session (S-1D-d, DAN-829-1). */
export async function logout(request: Request, deps: AuthDeps): Promise<Response> {
  return endSessions(request, deps, "logout", (token) => deps.closeSession(token), "clear");
}

/** POST /api/v1/auth/logout-all: this session and every other live one of the account (DAN-296). */
export async function logoutAll(request: Request, deps: AuthDeps): Promise<Response> {
  return endSessions(request, deps, "logout_all", (token) => deps.closeAllSessions(token), "keep");
}

/**
 * Closes on the server first, then clears the cookie and goes to the
 * provider; the answer is the same whether a session existed or not. When the
 * database fails, logout clears the cookie all the same and the session ends
 * at expiry or idle (Ductus DAN-99); logout-all answers 503 and keeps the
 * cookie, so it never reports a sign-out while the account's other sessions
 * live, and the browser can send it again (Ductus contract addendum on #1091,
 * item 3). As Ductus endSessions in src/server/auth/flow.ts at 393b8e0.
 */
async function endSessions(
  request: Request,
  deps: AuthDeps,
  stage: string,
  close: (token: string) => Promise<unknown>,
  onCloseFailure: "clear" | "keep",
): Promise<Response> {
  if (!isSameOrigin(request, deps.config.redirectUri.origin)) {
    logFailure(stage, "cross_origin");
    return failurePage(403);
  }
  const token = previousSessionToken(request.headers.get("cookie"));
  if (token) {
    try {
      await close(token);
    } catch (error) {
      logFailure(stage, errorCode(error));
      if (onCloseFailure === "keep") return failurePage(503);
    }
  }
  // Only then the provider (DAN-212), also without a live session: its own
  // may still be open (D-200 P2). Without an endpoint, or when the provider
  // fails, the local sign-out stands and "/" follows. Either way the next
  // login asks the provider to sign in again (INT-20b), and a login attempt
  // started before the sign-out is dropped with its cookie (INT-20e).
  let location = new URL(DEFAULT_RETURN_TO, deps.config.redirectUri.origin).href;
  try {
    const endSession = await deps.oidc.endSessionUrl();
    if (endSession) location = endSession.href;
  } catch (error) {
    logFailure("end_session", errorCode(error));
  }
  return redirect(location, [
    clearedSessionSetCookie(),
    signedOutSetCookie(),
    clearedLoginCookie(),
  ]);
}
