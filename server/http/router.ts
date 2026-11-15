// Router of /api/v1 (docs/server-map.md §3, step 8). A route is its contract
// from server/contracts plus a handler; the method and path come from the
// contract only. Refusals use the error words of the contract: FALLBACK
// (404 not_found), INTERNAL (500 internal) and the 405 of the fake server (U8). Later steps (session,
// schema from the contract) attach here with S-1B-b and U4.
import type { IncomingMessage, ServerResponse } from "node:http";

import { FALLBACK, INTERNAL, type RouteContract } from "../contracts/index.ts";

export type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export type Route = { readonly contract: RouteContract; readonly handle: Handler };
export type Router = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const NO_STORE = "no-store";

/** A JSON answer; the only way this folder writes a body. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  // Serialized before the head: a body that cannot be (BigInt, a cycle, a
  // throwing toJSON) throws while a 500 internal can still be sent instead.
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": NO_STORE,
    ...headers,
  });
  response.end(text);
}

/** The body of the 500 answer, exactly the contract's: one closed word, nothing else. */
export const INTERNAL_BODY = { error: INTERNAL.error.code } as const;

/**
 * The name of a thrown value for the log, never its message. Reading it never
 * throws: a throwing "name" getter, a Proxy or a revoked Proxy give a fixed word.
 */
export function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return error === null ? "null" : typeof error;
    const name: unknown = error.name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : "Error";
  } catch {
    return "unreadable";
  }
}

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
export function createRouter(routes: readonly Route[]): Router {
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
      sendJson(response, FALLBACK.error.status, { error: FALLBACK.error.code });
      return;
    }
    const route = methods.get(request.method ?? "");
    if (route === undefined) {
      const allow = [...methods.keys()].join(", ");
      sendJson(response, 405, { error: "method_not_allowed" }, { allow });
      return;
    }
    try {
      await route.handle(request, response);
    } catch (error) {
      // Only the name of the error: never its message, the request or a token.
      console.error("route failed", route.contract.id, errorName(error));
      if (!response.headersSent) sendJson(response, INTERNAL.error.status, INTERNAL_BODY);
      else response.destroy();
    }
  };
}
