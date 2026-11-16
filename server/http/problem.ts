// The one way server/http answers an error (S-1L.3, DAN-789): the problem
// body {code, messageKey, status, requestId} of a contract error, plus the v1
// word `error` (server/contracts, errorBody). Only errors of SERVER_ERRORS are
// answered; a code or status outside it is a programming error and becomes
// 500 internal, so no route can answer a key without a text in locales/.
// The body never carries an error's message, name, stack or SQL.
import { type ServerResponse, STATUS_CODES } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { type ErrorSpec, INTERNAL, type RouteContract, SERVER_ERRORS } from "../contracts/index.ts";

import { writeJson } from "./json.ts";
import { REQUEST_ID_HEADER, requestIdOf } from "./request-id.ts";
import { SECURITY_HEADERS } from "./security-header-values.ts";

/**
 * Headers an error answer keeps from before: the security headers, the
 * request id, Connection (refuse() closes) and Retry-After (503 while draining). Anything else a handler set
 * (Content-Length, Content-Encoding, Trailer, Set-Cookie, Location ...) would
 * break or leak through the problem body, so it is dropped.
 */
const KEPT = new Set(
  [...SECURITY_HEADERS.map(({ key }) => key), REQUEST_ID_HEADER, "Connection", "Retry-After"].map(
    (name) => name.toLowerCase(),
  ),
);

/** Responses whose head sendProblem writes; the router lets only these be errors. */
const answering = new WeakSet<ServerResponse>();

/** True while sendProblem writes this response's head (router.ts guards writeHead). */
export function isProblemAnswer(response: ServerResponse): boolean {
  return answering.has(response);
}

export type Problem = {
  readonly error: string;
  readonly code: string;
  readonly messageKey: string;
  readonly status: number;
  readonly requestId: string;
};

const BY_STATUS_AND_CODE: ReadonlyMap<string, ErrorSpec> = new Map(
  SERVER_ERRORS.map((spec) => [`${spec.status} ${spec.code}`, spec]),
);

/** The contract error for this status and code, or undefined when there is none. */
export function knownError(status: number, code: string): ErrorSpec | undefined {
  return BY_STATUS_AND_CODE.get(`${status} ${code}`);
}

/**
 * The problem body of a contract error; anything unknown gives the body of
 * 500 internal. Built from the contract's own spec, never from the caller's
 * text, so the key and status always match the code.
 */
export function problemOf(status: number, code: string, requestId: string): Problem {
  return problemOfSpec(knownError(status, code) ?? INTERNAL.error, requestId);
}

function problemOfSpec(spec: ErrorSpec, requestId: string): Problem {
  return {
    error: spec.code,
    code: spec.code,
    messageKey: spec.key,
    status: spec.status,
    requestId,
  };
}

/**
 * Answers the contract error for this status and code as a problem body; an
 * unknown pair answers 500 internal instead. X-Request-Id carries the request id either way.
 */
export function sendProblem(
  response: ServerResponse,
  status: number,
  code: string,
  headers: { readonly allow?: string } = {},
): void {
  const spec = knownError(status, code) ?? INTERNAL.error;
  if (!response.headersSent) {
    for (const name of response.getHeaderNames()) if (!KEPT.has(name)) response.removeHeader(name);
    // Trailers are kept apart from the headers; adding none clears them.
    response.addTrailers({});
    response.statusMessage = STATUS_CODES[spec.status] ?? "";
  }
  answering.add(response);
  const requestId = requestIdOf(response);
  const body = problemOfSpec(spec, requestId);
  const extra: Record<string, string> = headers.allow === undefined ? {} : { allow: headers.allow };
  writeJson(response, spec.status, body, extra);
}

/**
 * A browser navigation's error page (S-1E-a): the contract error `spec` of
 * the route, which must have an HTML body, answered with `html`. Only
 * the kept headers and the given Set-Cookie values (clearing a login
 * attempt) survive, so a handler's cookie or Location never rides on an
 * error. Any other spec answers 500 internal, as sendProblem does.
 */
export function sendHtmlProblem(
  response: ServerResponse,
  spec: ErrorSpec,
  html: string,
  setCookies: readonly string[] = [],
): void {
  if (spec.body !== "html" || knownError(spec.status, spec.code) === undefined) {
    sendProblem(response, INTERNAL.error.status, INTERNAL.error.code);
    return;
  }
  for (const name of response.getHeaderNames()) if (!KEPT.has(name)) response.removeHeader(name);
  response.addTrailers({});
  answering.add(response);
  const headers: Record<string, string | string[]> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-length": String(Buffer.byteLength(html)),
  };
  requestIdOf(response);
  if (setCookies.length > 0) headers["set-cookie"] = [...setCookies];
  response.writeHead(spec.status, STATUS_CODES[spec.status] ?? "", headers);
  response.end(html);
}

/**
 * An error of a route whose contract gives it no body (the back-channel
 * logout's 400 and 503: the caller is the provider, not a browser). Only an
 * error of this route's own contract with `body: "none"` is answered, with
 * `no-store` and an empty body; anything else answers 500 internal. Headers
 * are cleared as by sendProblem.
 */
export function sendBareRefusal(
  response: ServerResponse,
  contract: RouteContract,
  status: number,
): void {
  const spec = contract.errors.find((e) => e.status === status && e.body === "none");
  if (spec === undefined) {
    sendProblem(response, INTERNAL.error.status, INTERNAL.error.code);
    return;
  }
  for (const name of response.getHeaderNames()) if (!KEPT.has(name)) response.removeHeader(name);
  response.addTrailers({});
  response.statusMessage = STATUS_CODES[status] ?? "";
  answering.add(response);
  requestIdOf(response);
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0" });
  response.end();
}

/**
 * Answers an error of a route whose contract body is {status, ...} instead of
 * a problem (the evidence routes, docs/vs1-rute.md, DAN-811). Only an error of
 * this route's own contract, with a body its schema takes, is answered; any
 * other status, code or body answers 500 internal. Headers are cleared as by
 * sendProblem, and a Retry-After set before is dropped too: a 503 must bring
 * its own (whole seconds) and nothing else may have one.
 */
export function sendRouteRefusal(
  response: ServerResponse,
  contract: RouteContract,
  status: number,
  body: { readonly status: string; readonly [field: string]: unknown },
  headers: { readonly "retry-after"?: string } = {},
): void {
  const spec = contract.errors.find((e) => e.status === status && e.code === body.status);
  const schema = spec?.body;
  const retry = headers["retry-after"];
  if (
    spec === undefined ||
    typeof schema !== "object" ||
    !Value.Check(schema, body) ||
    (status === 503) !== (retry !== undefined) ||
    (retry !== undefined && !/^[1-9][0-9]{0,3}$/.test(retry))
  ) {
    // A Retry-After set before belongs to no answer of this writer, the 500 included.
    if (!response.headersSent) response.removeHeader("retry-after");
    sendProblem(response, INTERNAL.error.status, INTERNAL.error.code);
    return;
  }
  if (!response.headersSent) {
    for (const name of response.getHeaderNames()) {
      if (!KEPT.has(name) || name === "retry-after") response.removeHeader(name);
    }
    response.addTrailers({});
    response.statusMessage = STATUS_CODES[status] ?? "";
  }
  answering.add(response);
  // The id ties the answer to the server's record, as on a problem body.
  requestIdOf(response);
  writeJson(response, status, body, retry === undefined ? {} : { "retry-after": retry });
}
