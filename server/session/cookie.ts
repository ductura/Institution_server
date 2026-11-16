import { SESSION_COOKIE_NAME } from "./session-token.ts";

// The token newSessionToken writes: 32 random bytes, base64url, no padding.
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
// Only the space and tab browsers put after each ";" are skipped before a name.
const LEADING_SPACE = /^[ \t]+/u;

/**
 * The session token in a request's Cookie header (DAN-805, plan of attack
 * ductura/server#98). Node joins repeated Cookie headers with "; ", so one
 * string or a list both arrive here.
 *
 * Exactly one pair named `__Host-ductus_session` with a value of exactly 43
 * base64url characters gives the token. A value is taken as sent: never
 * unquoted, trimmed or percent-decoded into another token. Two or more such
 * pairs give no token at all: which one the browser meant cannot be told, and
 * a planted second cookie must never pick the session (cookie tossing).
 * Ended-session marks are not read here: the database decides whether the
 * session is live, as in Ductus for the evidence routes.
 */
export function sessionTokenFromCookie(
  header: string | readonly string[] | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const text = typeof header === "string" ? header : header.join("; ");
  let found: string | undefined;
  let seen = 0;
  for (const part of text.split(";")) {
    const pair = part.replace(LEADING_SPACE, "");
    const equals = pair.indexOf("=");
    if (equals < 0 || pair.slice(0, equals) !== SESSION_COOKIE_NAME) continue;
    seen += 1;
    found = pair.slice(equals + 1);
  }
  return seen === 1 && found !== undefined && TOKEN.test(found) ? found : undefined;
}
