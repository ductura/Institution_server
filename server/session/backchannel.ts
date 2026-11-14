/**
 * POST /api/auth/backchannel-logout (DAN-474, D-200 P4; OpenID Connect
 * Back-Channel Logout 1.0 §2.5 to §2.8). The provider calls it, not a
 * browser: no cookie, no origin and no session named by the caller counts,
 * only a logout token signed by the configured provider. It only closes
 * sessions (D-09). Contract (#1091 c.6683556284):
 *   200  closed, or nothing matched (§2.8)
 *   400  any invalid request or token, a replayed `jti` included
 *   503  the provider keys or the database are unavailable
 *   405  any other method (route file)
 * Every answer is `cache-control: no-store`. Logs carry a stage and a code,
 * never the token, `sub`, `sid` or `jti`.
 */
import type { LogoutVerifier } from "../external/srce-auth/index.ts";

import type { BackchannelLogout } from "../database/index.ts";

/** Ports the composer hands in (docs/server-map.md §2); see createLogoutVerifier. */
export type BackchannelDeps = {
  verifier: LogoutVerifier;
  backchannelLogout: BackchannelLogout;
};

/** A form body larger than this is refused unread. */
export const MAX_BACKCHANNEL_BODY_BYTES = 16 * 1024;

const HEADERS = { "cache-control": "no-store" };

function answer(status: 200 | 400 | 503): Response {
  return new Response(null, { status, headers: HEADERS });
}

function logFailure(stage: string, code: string): void {
  console.error("backchannel logout failed", stage, code);
}

async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function logoutToken(request: Request): Promise<string | undefined> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return undefined;
  let body: string | undefined;
  try {
    body = await readLimited(request, MAX_BACKCHANNEL_BODY_BYTES);
  } catch {
    return undefined;
  }
  if (body === undefined) return undefined;
  const values = new URLSearchParams(body).getAll("logout_token");
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
}

export async function backchannelLogout(
  request: Request,
  deps: BackchannelDeps,
): Promise<Response> {
  const token = await logoutToken(request);
  if (token === undefined) {
    logFailure("request", "malformed");
    return answer(400);
  }
  let verified;
  try {
    verified = await deps.verifier.verify(token);
  } catch {
    // The port answers with a result; a throw is treated as unavailable keys.
    logFailure("verify", "keys");
    return answer(503);
  }
  if (!verified.ok) {
    logFailure("verify", verified.code);
    return answer(verified.reason === "invalid" ? 400 : 503);
  }
  try {
    const result = await deps.backchannelLogout({
      // The account key's spelling of the issuer (F-042), as at login.
      issuer: deps.verifier.accountIssuer,
      subject: verified.sub,
      sid: verified.sid,
      jti: verified.jti,
    });
    if (!result.ok) {
      logFailure("close", result.reason);
      return answer(400);
    }
    return answer(200);
  } catch {
    logFailure("close", "database");
    return answer(503);
  }
}
