// The one way server/http writes a JSON body (docs/server-map.md §3).
import type { ServerResponse } from "node:http";

import { INTERNAL } from "../contracts/index.ts";

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
