// The session cookie at login (S-1E-a, DAN-808): the login callback in
// server/http reads the token a browser already had and sets the new one
// through these two, so that outside this folder no file names the cookie
// (ended-mark-coverage.test.ts, DAN-99). Same parsing and attributes as Ductus
// src/server/auth/flow.ts at 078c780, where readCookie and cookie() did both.
import { SESSION_COOKIE_NAME } from "./session-token.ts";

/** The raw session token in a Cookie header: the first pair with the exact name. */
export function previousSessionToken(cookieHeader: string | null): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE_NAME)
      return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The Set-Cookie of a new session: __Host- (Secure, Path=/, no Domain), HttpOnly, Lax. */
export function sessionSetCookie(token: string, expires: Date): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

/** The Set-Cookie that clears the session cookie at a sign-out (S-1D-c, DAN-828-1). */
export function clearedSessionSetCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
