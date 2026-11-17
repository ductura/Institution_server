// What a request gets when Node's parser refuses it, before any layer runs
// (DAN-851-1d2, QA FAIL on ductura/server#206). A malformed or repeated
// Content-Length gets the 400 its route's contract promises, instead of
// Node's bare 400:
// - the problem body content_length_invalid (MUTATION_GUARD), or
// - {status: "bad_request"} for a route whose contract refuses so (evidence).
// Every other parse error keeps Node's own answer (node:_http_server
// socketOnError), byte for byte. The connection always closes, as Node's does.
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { Socket } from "node:net";

import { problemOf } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import type { Route } from "./router.ts";
import { SECURITY_HEADERS } from "./security-header-values.ts";

/** Parser errors of the declared length: not a decimal, or two different values. */
const CONTENT_LENGTH_ERRORS: ReadonlySet<string> = new Set([
  "HPE_INVALID_CONTENT_LENGTH",
  "HPE_UNEXPECTED_CONTENT_LENGTH",
]);

/** Node's own status for the parse errors it does not answer 400. */
const NODE_STATUS: ReadonlyMap<string, number> = new Map([
  ["HPE_HEADER_OVERFLOW", 431],
  ["HPE_CHUNK_EXTENSIONS_OVERFLOW", 413],
  ["ERR_HTTP_REQUEST_TIMEOUT", 408],
]);

// A request line; the last one before the error is the refused request's.
const REQUEST_LINE = /([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/gu;

const head = (status: number, headers: readonly string[]): string =>
  [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, ...headers, "", ""].join("\r\n");

/** The 400 answer with this JSON body, its own request id and the security headers. */
export function contentLengthAnswer(body: unknown, requestId: string): string {
  const text = JSON.stringify(body);
  return (
    head(400, [
      ...SECURITY_HEADERS.map(({ key, value }) => `${key}: ${value}`),
      `${REQUEST_ID_HEADER}: ${requestId}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(text)}`,
      "Connection: close",
    ]) + text
  );
}

/**
 * The method and path of the refused request, from the bytes Node parsed, or
 * null when its request line came in an earlier packet. Bytes a client sent
 * choose only the shape of its own 400.
 */
export function refusedRequestLine(error: Error): { method: string; path: string } | null {
  const { rawPacket, bytesParsed } = error as { rawPacket?: unknown; bytesParsed?: unknown };
  if (!Buffer.isBuffer(rawPacket)) return null;
  const end = typeof bytesParsed === "number" ? bytesParsed : rawPacket.length;
  const text = rawPacket.subarray(0, end).toString("latin1");
  const last = [...text.matchAll(REQUEST_LINE)].at(-1);
  return last?.[1] !== undefined && last[2] !== undefined
    ? { method: last[1], path: last[2] }
    : null;
}

/** The body the route of this request line promises for a bad Content-Length. */
export function contentLengthBody(
  routes: readonly Route[],
  line: { method: string; path: string } | null,
  requestId: string,
): unknown {
  const route = routes.find(
    (r) => r.contract.method === line?.method && r.contract.path === line.path.split("?")[0],
  );
  const errors = route?.contract.errors ?? [];
  const problem = errors.some((e) => e.status === 400 && e.code === "content_length_invalid");
  if (!problem && errors.some((e) => e.status === 400 && e.code === "bad_request")) {
    return { status: "bad_request" };
  }
  return problemOf(400, "content_length_invalid", requestId);
}

/** True while an answer of this socket has written its head (Node's own check). */
function answerStarted(socket: Socket): boolean {
  const message: unknown = Reflect.get(socket, "_httpMessage");
  return (
    typeof message === "object" && message !== null && Reflect.get(message, "_headerSent") === true
  );
}

/**
 * The server's clientError listener. As Node, it writes only when no answer
 * on this socket has started (a pipelined one in flight would be corrupted),
 * then destroys the socket.
 */
export function createClientErrorListener(
  routes: readonly Route[],
): (error: Error, socket: Socket) => void {
  return (error, socket) => {
    if (socket.writable && !answerStarted(socket)) {
      const code = (error as { code?: unknown }).code;
      const name = typeof code === "string" ? code : "";
      if (CONTENT_LENGTH_ERRORS.has(name)) {
        const id = randomUUID();
        const body = contentLengthBody(routes, refusedRequestLine(error), id);
        socket.write(contentLengthAnswer(body, id));
      } else {
        socket.write(head(NODE_STATUS.get(name) ?? 400, ["Connection: close"]));
      }
    }
    socket.destroy(error);
  };
}
