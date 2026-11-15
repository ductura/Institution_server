// The one way server/http writes a JSON body (docs/server-map.md §3).
import type { ServerResponse } from "node:http";

const NO_STORE = "no-store";

/** Headers only writeJson and request-id.ts set: a caller cannot replace them. */
const RESERVED = new Set(["content-type", "cache-control", "x-request-id"]);

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
  for (const name of Object.keys(headers)) {
    if (RESERVED.has(name.toLowerCase())) throw new Error(`${name} is set by writeJson`);
  }
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": NO_STORE,
    // Always stated: a length Node kept from a refused end(body) never cuts this body.
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

/**
 * A JSON success answer of a route. A status outside 200 to 299, or one with
 * no body (204, 205), throws, so a handler cannot answer an error in another
 * shape: the router turns the throw into 500 internal. Errors go through
 * sendProblem.
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (
    !Number.isInteger(status) ||
    status < 200 ||
    status > 299 ||
    status === 204 ||
    status === 205
  ) {
    throw new Error("an error answer goes through sendProblem");
  }
  writeJson(response, status, body, headers);
}
