// Router of /api/v1 (docs/server-map.md §3, step 8). A route is its contract
// from server/contracts plus a handler; the method and path come from the
// contract only. Refusals are problem bodies (problem.ts) of the contract:
// FALLBACK (404 not_found), METHOD_NOT_ALLOWED (405) and INTERNAL (500). Later steps (session, schema from the contract) attach here with
// S-1B-b and U4.
import type { IncomingMessage, ServerResponse } from "node:http";

import { FALLBACK, METHOD_NOT_ALLOWED, type RouteContract } from "../contracts/index.ts";

import { reportServerError, type ServerErrorReporter } from "./error-catalog.ts";
import { isProblemAnswer, sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { answerInternal } from "./security-headers.ts";

/**
 * The raw (still percent-encoded) segments a contract path's `{name}` took;
 * no prototype, frozen. The route decodes and checks its own: a work id only
 * through workIdFromPath (server/contracts, S-1H.1-c), which decodes once.
 */
export type PathParams = Readonly<Record<string, string>>;
/** `params` is empty for a route without parameters; a direct caller may leave it out. */
export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  params?: PathParams,
) => Promise<void>;
export type Route = { readonly contract: RouteContract; readonly handle: Handler };
export type Router = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export { errorName } from "./error-catalog.ts";
export { sendJson } from "./json.ts";

// An origin-form path as sent: "/" then no "//", backslash or dot segment. Nothing is
// decoded or rewritten (as WHATWG URL would), so the router and any layer that
// reads request.url see the same path. The Host header never selects a route.
const BAD_PATH_RE = /\/\/|\\|(?:^|\/)\.{1,2}(?:\/|$)/u;

/** The path a route is chosen by, without the query; undefined when it is not one. */
export function routePath(target: string | undefined): string | undefined {
  const path = (target ?? "").split("?", 1)[0] ?? "";
  if (!path.startsWith("/") || BAD_PATH_RE.test(path)) return undefined;
  return path;
}

const NO_PARAMS: PathParams = Object.freeze(Object.create(null) as Record<string, string>);
const PARAM_RE = /^\{(\w+)\}$/u;

type Template = { readonly segments: readonly string[]; readonly methods: Map<string, Route> };

/** One segment of a contract path: its parameter name, or undefined for a literal. */
const paramName = (segment: string): string | undefined => PARAM_RE.exec(segment)?.[1];

/** Whether some request path matches both contract paths (DAN-857-1). */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (s, i) => s === b[i] || paramName(s) !== undefined || paramName(b[i] ?? "") !== undefined,
  );
}

/**
 * The params of a request path under a template, or undefined when it does not
 * match: each `{name}` takes exactly one non-empty segment as sent. Nothing is
 * decoded here, so the value is never read as a path.
 */
function match(template: readonly string[], path: readonly string[]): PathParams | undefined {
  if (template.length !== path.length) return undefined;
  const params = Object.create(null) as Record<string, string>;
  for (const [i, segment] of template.entries()) {
    const sent = path[i] ?? "";
    const name = paramName(segment);
    if (name === undefined ? segment !== sent : sent === "") return undefined;
    if (name !== undefined) params[name] = sent;
  }
  return Object.freeze(params);
}

/**
 * Builds the router. Two routes on one method and path, or two contract paths
 * that one request path could match, are a programming error.
 */
export function createRouter(
  routes: readonly Route[],
  report: ServerErrorReporter = reportServerError,
): Router {
  const byPath = new Map<string, Template>();
  for (const route of routes) {
    const { method, path } = route.contract;
    const template = byPath.get(path) ?? { segments: path.split("/"), methods: new Map() };
    if (template.methods.has(method)) throw new Error(`duplicate route ${method} ${path}`);
    for (const [other, { segments }] of byPath) {
      if (other !== path && overlaps(segments, template.segments)) {
        throw new Error(`overlapping routes ${other} and ${path}`);
      }
    }
    template.methods.set(method, route);
    byPath.set(path, template);
  }
  const templates = [...byPath.values()].filter((t) => t.segments.some((s) => paramName(s)));

  /** The methods and params of the one contract path a request path matches. */
  const find = (path: string): { methods: Map<string, Route>; params: PathParams } | undefined => {
    const literal = byPath.get(path);
    if (literal !== undefined && !templates.includes(literal)) {
      return { methods: literal.methods, params: NO_PARAMS };
    }
    const sent = path.split("/");
    for (const template of templates) {
      const params = match(template.segments, sent);
      if (params !== undefined) return { methods: template.methods, params };
    }
    return undefined;
  };

  return async (request, response) => {
    const path = routePath(request.url);
    const found = path === undefined ? undefined : find(path);
    if (found === undefined) {
      sendProblem(response, FALLBACK.error.status, FALLBACK.error.code);
      return;
    }
    const { methods, params } = found;
    const route = methods.get(request.method ?? "");
    if (route === undefined) {
      const allow = [...methods.keys()].join(", ");
      const { status, code } = METHOD_NOT_ALLOWED.error;
      sendProblem(response, status, code, { allow });
      return;
    }
    try {
      guardErrorHead(response);
      await route.handle(request, response, params);
    } catch (error) {
      // Only the class of the error: never its message, the request or a token.
      // The request id ties the record to the answer the caller got.
      report("route", error, requestIdOf(response), route.contract.id);
      answerInternal(response);
    }
  };
}

/**
 * A handler's head with a status of 400 or more (writeHead, or statusCode
 * with end, write or flushHeaders, which all call writeHead) throws unless
 * sendProblem writes it, so no route answers an error outside the problem
 * body (S-1L.3): the throw becomes 500 internal like any failed handler.
 */
function guardErrorHead(response: ServerResponse): void {
  const writeHead = response.writeHead;
  const guarded = function (this: ServerResponse, ...args: Parameters<typeof writeHead>) {
    const [status] = args;
    if ((typeof status !== "number" || status >= 400) && !isProblemAnswer(response)) {
      throw new Error("an error answer goes through sendProblem");
    }
    return writeHead.apply(this, args);
  };
  response.writeHead = guarded as typeof writeHead;
}
