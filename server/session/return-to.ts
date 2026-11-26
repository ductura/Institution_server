/**
 * Where the browser goes after login (docs/BACKEND.md 4.3). Only a path of
 * this application is accepted; anything that a browser could read as
 * another origin falls back to the default page. The value is stored with
 * the login attempt (state), never read from the callback query.
 */
export const DEFAULT_RETURN_TO = "/aplikacija/";

/** Where a sign-out without a provider end-session endpoint lands (not a login return). */
export const SIGNED_OUT_PATH = "/";

// Only these two trees of the address map (D-318) may be returned to.
const ALLOWED_ROOTS = ["/aplikacija", "/administracija"] as const;
// The old web mount, mapped onto the new one.
const LEGACY_ROOT = "/app/web";

const MAX_LENGTH = 512;
const BASE = "https://ductus.invalid";
// C0 and C1 controls, line and paragraph separators, and invisible format
// characters (zero-width, bidi), which browsers strip or reinterpret.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) {
    return DEFAULT_RETURN_TO;
  }
  // "//host" and "/\host" are protocol-relative in browsers; a backslash is
  // never needed in our paths.
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    UNSAFE.test(value)
  ) {
    return DEFAULT_RETURN_TO;
  }
  const mapped = mapLegacy(value);
  let parsed: URL;
  try {
    parsed = new URL(mapped, BASE);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  // Login routes would only loop back into the flow.
  if (parsed.origin !== BASE || isApiPath(parsed.pathname)) return DEFAULT_RETURN_TO;
  // The parser removes dot segments, so "/.//host" and "/%2e//host" come out
  // as "//host". What is returned is what must be safe, so check it again.
  const result = parsed.pathname + parsed.search + parsed.hash;
  if (result.startsWith("//") || result.startsWith("/\\")) return DEFAULT_RETURN_TO;
  // Checked on the parsed path, so "/aplikacija/../x" and "/%61plikacija" cannot slip by.
  if (!isAllowedRoot(parsed.pathname)) return DEFAULT_RETURN_TO;
  return result;
}

/** "/app/web" and "/app/web/..." become "/aplikacija" and "/aplikacija/..." (query and hash kept). */
function mapLegacy(value: string): string {
  if (!value.startsWith(LEGACY_ROOT)) return value;
  const rest = value.slice(LEGACY_ROOT.length);
  if (rest === "" || /^[/?#]/u.test(rest)) return `/aplikacija${rest}`;
  return value;
}

function isAllowedRoot(pathname: string): boolean {
  return ALLOWED_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

// Decoding rounds before an encoded path counts as unreadable.
const MAX_DECODE_ROUNDS = 3;

/**
 * True for "/api" and anything below it, however the path is spelled:
 * any letter case, percent-encoded letters or slashes, and encodings
 * nested up to MAX_DECODE_ROUNDS deep. A path that does not decode
 * cleanly within that bound also counts, so the check fails closed.
 */
function isApiPath(pathname: string): boolean {
  let path = pathname;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    const lower = path.toLowerCase();
    if (lower === "/api" || lower.startsWith("/api/")) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return true;
    }
    if (decoded === path) return false;
    path = decoded;
  }
  return true;
}
