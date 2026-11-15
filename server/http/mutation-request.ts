// Origin guard for a state-changing request (docs/server-map.md §3, step 7;
// ARCHITECTURE §4 t. 4). Port of checkMutationRequest from Ductus
// src/server/http/mutation-request.ts at d52a92c3. Changes: it runs as a layer
// before the router on IncomingMessage, so it does not check the route's
// method (the router answers 405); every method but GET, HEAD and OPTIONS is
// state-changing, an unknown name included; a header sent twice is refused
// instead of being read joined by a comma; no configured origin refuses every
// such request. The body is never read here. readBodyWithLimit follows in
// part a2 (DAN-777).
import type { IncomingMessage, ServerResponse } from "node:http";

import { refuse } from "./security-headers.ts";

/** An allow-list: any other method name is state-changing. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Codes of server/contracts (403). */
export type OriginRefusal = "origin_missing" | "origin_mismatch" | "cross_site";
export type OriginCheck = { ok: true } | { ok: false; status: 403; reason: OriginRefusal };

const OK: OriginCheck = { ok: true };
const refused = (reason: OriginRefusal): OriginCheck => ({ ok: false, status: 403, reason });

/**
 * A state-changing request passes only with exactly one Origin equal to the
 * expected origin, and with Sec-Fetch-Site absent or exactly once
 * "same-origin" (a same-site subdomain is another origin). The comparison is
 * exact: browsers send the canonical form.
 */
export function checkMutationRequest(
  request: IncomingMessage,
  expectedOrigin: string | null,
): OriginCheck {
  if (SAFE_METHODS.has(request.method ?? "")) return OK;
  const headers = request.headersDistinct;
  const origins = headers.origin ?? [];
  if (origins.length > 1) return refused("origin_mismatch");
  const origin = origins[0];
  if (origin === undefined || origin === "" || origin === "null") return refused("origin_missing");
  if (expectedOrigin === null || origin !== expectedOrigin) return refused("origin_mismatch");
  const sites = headers["sec-fetch-site"];
  if (sites !== undefined && (sites.length !== 1 || sites[0] !== "same-origin")) {
    return refused("cross_site");
  }
  return OK;
}

/** A bare scheme://host[:port] of http or https, exactly as URL prints it. */
export function isCanonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

/** Step 7 of the pipeline; null refuses every state-changing request. */
export function originLayer(
  expectedOrigin: string | null,
): (request: IncomingMessage, response: ServerResponse) => Promise<"next" | "done"> {
  // A misconfigured origin must fail loudly, never match anything.
  if (expectedOrigin !== null && !isCanonicalOrigin(expectedOrigin)) {
    throw new Error("expected origin must be a bare scheme://host[:port]");
  }
  return async (request, response) => {
    const check = checkMutationRequest(request, expectedOrigin);
    if (check.ok) return "next";
    refuse(response, check.status, check.reason);
    return "done";
  };
}
