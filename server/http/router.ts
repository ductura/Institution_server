// Router of /api/v1 (docs/server-map.md §3, step 8). A route is its contract
// from server/contracts plus a handler; the method and path come from the
// contract only. Refusals use the error words of the contract: FALLBACK
// (404 not_found) and the 405 of the fake server (U8). Later steps (session,
// schema from the contract) attach here with S-1B-b and U4.
import type { IncomingMessage, ServerResponse } from "node:http";

import { FALLBACK, type RouteContract } from "../contracts/index.ts";

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
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": NO_STORE,
    ...headers,
  });
  response.end(JSON.stringify(body));
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
    // Only the path counts: the query never selects a route. The base is a
    // placeholder, the Host header is never trusted for routing.
    const path = new URL(request.url ?? "/", "http://route.invalid").pathname;
    const methods = byPath.get(path);
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
      console.error("route failed", route.contract.id, (error as Error).name);
      if (!response.headersSent) sendJson(response, 500, { error: "internal" });
      else response.destroy();
    }
  };
}
