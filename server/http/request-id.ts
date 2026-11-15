// The request id (S-1L.3, DAN-789): one lowercase UUID v4 per request, made
// here and never taken from the client, so a caller cannot choose, repeat or
// inject the id that logs and the problem body carry. It is kept per response,
// made at the first error or log line that needs it, and sent as X-Request-Id
// with that answer; a success answer stays as it was.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

export const REQUEST_ID_HEADER = "X-Request-Id";

const ids = new WeakMap<ServerResponse, string>();

/** The id of this response's request; the first call makes it and sets the header. */
export function requestIdOf(response: ServerResponse): string {
  let id = ids.get(response);
  if (id === undefined) {
    id = randomUUID();
    ids.set(response, id);
  }
  if (!response.headersSent) response.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
