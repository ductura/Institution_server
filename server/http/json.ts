// The one way server/http writes a JSON body (docs/server-map.md §3).
import type { ServerResponse } from "node:http";

const NO_STORE = "no-store";

/**
 * Writes any JSON answer. Only this folder's sendJson and sendProblem call
 * it: an error body must be a problem (problem.ts).
 */
export function writeJson(
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

/**
 * A JSON answer of a route that is not an error. A status of 400 or more
 * throws, so a handler cannot answer an error in another shape: the router
 * turns the throw into 500 internal. Errors go through sendProblem.
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (!Number.isInteger(status) || status >= 400) {
    throw new Error("an error answer goes through sendProblem");
  }
  writeJson(response, status, body, headers);
}
