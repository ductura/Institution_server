// The security headers the server enforces on every /api/v1 answer (SRV-1401,
// DAN-296, plan M1.6). Three of them are the server's alone: no route sets
// its own Content-Security-Policy, Permissions-Policy or
// Strict-Transport-Security, because the last word on the head is here. The
// rest of the headers (security-header-values.ts) a route may still choose.
// This file imports nothing from server/http, so the values can be read by
// security-header-values.ts and problem.ts without a cycle.
import type { ServerResponse } from "node:http";

/**
 * API answers carry no markup to run; nothing may load from them. No
 * 'unsafe-inline' and no 'unsafe-eval' (M1.6).
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Camera, microphone and location off, with the other powerful features. */
export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=(), clipboard-write=(self)";

/** Two years; ignored over plain http (RFC 6797 §8.1), so it acts behind TLS. */
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains";

export const CSP_HEADER = "Content-Security-Policy";
export const PERMISSIONS_POLICY_HEADER = "Permissions-Policy";
export const HSTS_HEADER = "Strict-Transport-Security";

/**
 * The mark of a staging deployment (STG-PRIJAVA, Ductus#2055): on every
 * answer of a server started with DUCTURA_DEPLOYMENT=staging, so nobody takes
 * it, or its fake login, for production. The server's alone, like the policies.
 */
export const DEPLOYMENT_HEADER = "X-Ductura-Deployment";
export const STAGING_DEPLOYMENT = "staging";

/**
 * Where the server runs: local (development and CI) sends no HSTS (M1.6);
 * staging marks every answer with DEPLOYMENT_HEADER.
 */
export type SecurityMode = { readonly local: boolean; readonly staging?: boolean };
/** The default everywhere a mode is not given: HSTS on. */
export const PRODUCTION_SECURITY: SecurityMode = Object.freeze({ local: false });

/** The header names only the server may set, lower case. */
export const ENFORCED_HEADER_NAMES: readonly string[] = Object.freeze(
  [CSP_HEADER, PERMISSIONS_POLICY_HEADER, HSTS_HEADER, DEPLOYMENT_HEADER].map((name) =>
    name.toLowerCase(),
  ),
);

/** The enforced headers of a mode, in this order. */
export function enforcedHeaders(
  mode: SecurityMode,
): readonly { readonly key: string; readonly value: string }[] {
  return Object.freeze([
    { key: CSP_HEADER, value: CONTENT_SECURITY_POLICY },
    { key: PERMISSIONS_POLICY_HEADER, value: PERMISSIONS_POLICY },
    ...(mode.local ? [] : [{ key: HSTS_HEADER, value: STRICT_TRANSPORT_SECURITY }]),
    ...(mode.staging === true ? [{ key: DEPLOYMENT_HEADER, value: STAGING_DEPLOYMENT }] : []),
  ]);
}

const enforcing = new WeakSet<ServerResponse>();
const isEnforced = (name: unknown): boolean =>
  typeof name === "string" && ENFORCED_HEADER_NAMES.includes(name.toLowerCase());

type HeaderArgument = Record<string, unknown> | unknown[];

/** The headers argument of writeHead without the enforced names; anything else as given. */
function withoutEnforced(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    // [[name, value], ...] or the flat [name, value, name, value, ...].
    if (headers.every((item) => Array.isArray(item))) {
      return headers.filter((pair) => !isEnforced((pair as unknown[])[0]));
    }
    const kept: unknown[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (!isEnforced(headers[i])) kept.push(headers[i], headers[i + 1]);
    }
    return kept;
  }
  if (typeof headers === "object" && headers !== null) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers as HeaderArgument)) {
      if (!isEnforced(name)) kept[name] = value;
    }
    return kept;
  }
  return headers;
}

/**
 * Makes the enforced headers of `mode` the last word on this response's head:
 * every way Node writes a head (writeHead, and end, write or flushHeaders,
 * which call it) goes through the wrapper, which drops a handler's own value
 * of these names, in setHeader or in the writeHead argument, and sets the
 * server's. In local mode HSTS is removed. Wraps this response only, once.
 */
export function enforceSecurityHeaders(response: ServerResponse, mode: SecurityMode): void {
  if (enforcing.has(response)) return;
  enforcing.add(response);
  const headers = enforcedHeaders(mode);
  const writeHead = response.writeHead;
  const enforced = function (this: ServerResponse, ...args: unknown[]) {
    if (!this.headersSent) {
      const last = args.length - 1;
      if (last >= 1 && typeof args[last] !== "string") args[last] = withoutEnforced(args[last]);
      for (const { key, value } of headers) this.setHeader(key, value);
      if (mode.local) this.removeHeader(HSTS_HEADER);
      if (mode.staging !== true) this.removeHeader(DEPLOYMENT_HEADER);
    }
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  };
  response.writeHead = enforced as typeof writeHead;
}
