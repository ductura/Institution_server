/**
 * The login and callback routes (B-6; docs/BACKEND.md 4.3), as plain Request
 * to Response functions so tests drive them without a server; the HTTP
 * routes over them come in the second PR of S-1E-a. Every failed login ends
 * on a 303 to the sign-in page with one of two codes (DAN-1081,
 * SIGN_IN_FAILURE): the browser learns neither which check failed nor
 * whether an institution exists. Logs carry a stage, an error code and that
 * code, never a value from the request or the provider. Ported from Ductus src/server/auth/flow.ts at
 * 078c780 (S-1E-a, DAN-808); logout-all (S-1D-c, DAN-828-1) from 333e163;
 * logout (S-1D-d, DAN-829-1) from 393b8e0.
 */
import { messagesHr as t } from "../../locales/index.ts";
import { SIGN_IN_FAILURE, type SignInFailureCode } from "../contracts/index.ts";
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

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function cookie(name: string, value: string, attributes: string): string {
  // __Host-: Secure, Path=/ and no Domain, so the cookie belongs to this host alone.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; ${attributes}`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

type Attempt = LoginChecks & {
  returnTo: string;
};

function encodeAttempt(attempt: Attempt): string {
  return Buffer.from(JSON.stringify({ v: 1, ...attempt })).toString("base64url");
}

// The cookie is not signed: it is __Host- and HttpOnly, so whoever can write
// it already controls this origin. It is still parsed as untrusted input.
function decodeAttempt(value: string | undefined): Attempt | undefined {
  if (!value || value.length > MAX_ATTEMPT_CHARS) return undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { v, state, nonce, codeVerifier, returnTo } = raw as Record<string, unknown>;
    if (v !== 1) return undefined;
    for (const random of [state, nonce, codeVerifier]) {
      if (typeof random !== "string" || !RANDOM_VALUE.test(random)) return undefined;
    }
    return {
      state: state as string,
      nonce: nonce as string,
      codeVerifier: codeVerifier as string,
      returnTo: offSignInPage(safeReturnTo(returnTo)),
    };
  } catch {
    return undefined;
  }
}

/**
 * A login that succeeds never lands on the sign-in page: its failure card
 * would show over a live session (Ductus#2031 R4, S4). A first path segment
 * that is "prijava" in any letter case, or that is percent-encoded at all
 * (no page of the app needs that, and a router may decode it), goes to the
 * default page.
 */
export function offSignInPage(returnTo: string): string {
  const first = new URL(returnTo, "https://ductus.invalid").pathname.split("/")[1] ?? "";
  const page = SIGN_IN_FAILURE.page.slice(1);
  return first.toLowerCase() === page || first.includes("%") ? DEFAULT_RETURN_TO : returnTo;
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

/**
 * Where a failed login goes (DAN-1081): the sign-in page with the code, on
 * the configured origin, or relative when no configuration loaded. Only
 * constants and that origin, never a value from the request.
 */
export function signInFailureLocation(code: SignInFailureCode, origin?: string): string {
  const target = `${SIGN_IN_FAILURE.page}?${SIGN_IN_FAILURE.param}=${code}`;
  return origin === undefined ? target : new URL(target, origin).href;
}

/**
 * A failed login: exactly one log line (stage, error code, the code the
 * browser gets; the last tells "provider down" from "refused", Ductus#2031
 * V5) and a 303 to the sign-in page. `cookies` only ever clears the attempt.
 */
export function failedLogin(
  stage: string,
  detail: string,
  code: SignInFailureCode,
  origin?: string,
  cookies: string[] = [],
): Response {
  console.error("login failed", stage, detail, code);
  return redirect(signInFailureLocation(code, origin), cookies);
}

/** The HTML of the neutral page of sign-out; step 7 of the pipeline answers a refused origin with it too. */
export function failureHtml(status: 400 | 403 | 503): string {
  const body = status === 503 ? t.auth.unavailableBody : t.auth.failedBody;
  return `<!doctype html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.auth.failedTitle)} · ${escapeHtml(t.app.name)}</title></head>
<body><main><h1>${escapeHtml(t.auth.failedTitle)}</h1><p>${escapeHtml(body)}</p>
<p><a href="${LOGIN_PATH}">${escapeHtml(t.auth.retry)}</a> · <a href="/">${escapeHtml(t.auth.home)}</a></p></main></body></html>`;
}

/** The neutral page a failed sign-out ends on. */
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

/** GET /api/v1/auth/login?returnTo=/path */
export async function startLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const checks = newLoginChecks();
  let location: URL;
  try {
    location = await deps.oidc.authorizationUrl(checks);
  } catch (error) {
    return failedLogin(
      "authorize",
      errorCode(error),
      "provider_unavailable",
      deps.config.redirectUri.origin,
    );
  }
  // A return path that normalizes past the decoder's limit (a long
  // non-ASCII path, percent-encoded by URL) would give an attempt that
  // finishLogin refuses; such an attempt returns to the default page instead
  // (Codex on #104; the same gap is in Ductus flow.ts at 078c780).
  let attempt = encodeAttempt({ ...checks, returnTo });
  if (attempt.length > MAX_ATTEMPT_CHARS) {
    attempt = encodeAttempt({ ...checks, returnTo: DEFAULT_RETURN_TO });
  }
  return redirect(location.href, [
    cookie(LOGIN_COOKIE_NAME, attempt, `Max-Age=${LOGIN_COOKIE_MAX_AGE}`),
  ]);
}

/** Clears the attempt cookie; every failed callback sends it, a config failure included. */
export const clearedLoginCookie = () => cookie(LOGIN_COOKIE_NAME, "", "Max-Age=0");

/** GET /api/v1/auth/callback?code=…&state=… */
export async function finishLogin(request: Request, deps: AuthDeps): Promise<Response> {
  // The attempt is single use: whatever happens next, its cookie is cleared,
  // so a replayed callback finds no state to match.
  // A failure never sets or clears the session cookie (Ductus#2031 S1, S3).
  const origin = deps.config.redirectUri.origin;
  const failed = (stage: string, detail: string, code: SignInFailureCode = "login_failed") =>
    failedLogin(stage, detail, code, origin, [clearedLoginCookie()]);
  const attempt = decodeAttempt(readCookie(request, LOGIN_COOKIE_NAME));
  if (!attempt) return failed("callback", "no_attempt");
  // The state is checked here, before the provider is asked for anything:
  // a callback that is not this attempt's is login_failed even when the
  // provider is down (Ductus#2031 V4; Codex CLI on #301). The library
  // checks it again.
  const states = new URL(request.url).searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== attempt.state) return failed("callback", "state");

  let verified;
  try {
    verified = await deps.oidc.verify(new URL(request.url), attempt);
  } catch (error) {
    const down = isProviderUnavailable(error);
    return failed("verify", errorCode(error), down ? "provider_unavailable" : "login_failed");
  }

  const claims = identityFromClaims(verified.idToken, verified.userinfo);
  if (!claims.ok) return failed("claims", claims.reason);

  const { token, tokenHash } = newSessionToken();
  let opened;
  try {
    opened = await deps.openSession({ issuer: verified.issuer, ...claims.identity, tokenHash });
  } catch (error) {
    return failed("open_session", errorCode(error), "provider_unavailable");
  }
  // Every reason alike: refused, conflict or any other (Ductus#2031 K3, V1).
  if (!opened.ok) return failed("open_session", opened.reason);

  // A session cookie the browser already had (another user's, or one planted
  // before login) is closed, never reused: the new session has a new token.
  const previous = previousSessionToken(request.headers.get("cookie"));
  if (previous) {
    await deps
      .closeSession(previous)
      .catch((error: unknown) => logFailure("close_previous", errorCode(error)));
  }

  return redirect(new URL(attempt.returnTo, origin).href, [
    clearedLoginCookie(),
    sessionSetCookie(token, opened.expires),
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
  // fails, the local sign-out stands and "/" follows.
  let location = new URL(DEFAULT_RETURN_TO, deps.config.redirectUri.origin).href;
  try {
    const endSession = await deps.oidc.endSessionUrl();
    if (endSession) location = endSession.href;
  } catch (error) {
    logFailure("end_session", errorCode(error));
  }
  return redirect(location, [clearedSessionSetCookie()]);
}
