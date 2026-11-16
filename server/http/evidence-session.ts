// The session step of the evidence routes (DAN-805, VS-1 narrow cut, step 1;
// docs/vs1-rute.md "Zaštita prije tijela"). Ported from Ductus
// src/server/evidence/ingest-http.ts at d52a92c3 (the cookie and live-session
// part of readGuardedBody) for node:http instead of Next.js.
import type { IncomingMessage } from "node:http";

import { type ActorReader, checkSession, sessionTokenFromCookie } from "../session/index.ts";

import { declaredLengthRefusal } from "./mutation-request.ts";

/** The answer of a refused step: the body and headers of the route's vectors. */
export type EvidenceRefusal = {
  readonly ok: false;
  readonly status: 401 | 503;
  readonly body:
    | { readonly status: "unauthenticated" }
    | { readonly status: "unavailable"; readonly stage: "context" };
  readonly headers: Readonly<Record<string, string>>;
};

export type EvidenceSession =
  { readonly ok: true; readonly token: string; readonly verified: boolean } | EvidenceRefusal;

const UNAUTHENTICATED: EvidenceRefusal = Object.freeze({
  ok: false,
  status: 401,
  body: Object.freeze({ status: "unauthenticated" }),
  headers: Object.freeze({ "cache-control": "no-store" }),
});

const CONTEXT: EvidenceRefusal = Object.freeze({
  ok: false,
  status: 503,
  body: Object.freeze({ status: "unavailable", stage: "context" }),
  headers: Object.freeze({ "cache-control": "no-store", "retry-after": "5" }),
});

/**
 * The session cookie of the request, and with `live` the session in the
 * database, before a single body byte is read (F-098). With `live`, a declared
 * Content-Length the body reader refuses unread (400 or 413) is not worth a
 * database round trip: the token passes unverified (`verified: false`) and
 * the body reader answers. This step never reads the body, never writes a
 * response or a cookie and never changes the session row.
 */
export async function evidenceSession(
  request: IncomingMessage,
  actors: ActorReader,
  options: { live: boolean; maxBytes: number },
): Promise<EvidenceSession> {
  try {
    const token = sessionTokenFromCookie(request.headers.cookie);
    const live = options.live && declaredLengthRefusal(request, options.maxBytes) === null;
    const checked = await checkSession(token, actors, { live });
    if (checked.ok) return { ok: true, token: checked.token, verified: checked.verified };
    return checked.refusal === "unauthenticated" ? UNAUTHENTICATED : CONTEXT;
  } catch {
    return CONTEXT;
  }
}
