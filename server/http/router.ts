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

export type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
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

/** Builds the router; two routes on one method and path are a programming error. */
export function createRouter(
  routes: readonly Route[],
  report: ServerErrorReporter = reportServerError,
): Router {
  const byPath = new Map<string, Map<string, Route>>();
  for (const route of routes) {
    const { method, path } = route.contract;
    const methods = byPath.get(path) ?? new Map<string, Route>();
    if (methods.has(method)) throw new Error(`duplicate route ${method} ${path}`);
    methods.set(method, route);
    byPath.set(path, methods);
  }

  return async (request, response) => {
    const path = routePath(request.url);
    const methods = path === undefined ? undefined : byPath.get(path);
    if (methods === undefined) {
      sendProblem(response, FALLBACK.error.status, FALLBACK.error.code);
      return;
    }
    const route = methods.get(request.method ?? "");
    if (route === undefined) {
      const allow = [...methods.keys()].join(", ");
      const { status, code } = METHOD_NOT_ALLOWED.error;
      sendProblem(response, status, code, { allow });
      return;
    }
    try {
      guardErrorHead(response);
      await route.handle(request, response);
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
