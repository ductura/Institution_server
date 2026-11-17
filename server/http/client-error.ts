// What a request gets when Node's parser refuses it, before any layer runs
// (DAN-851-1d2, QA and review on ductura/server#206). A malformed or repeated
// Content-Length gets the 400 its route's contract has, instead of Node's
// bare 400:
// - the problem body content_length_invalid (MUTATION_GUARD);
// - {status: code} for a route whose contract refuses so (evidence);
// - no body for a route whose 400 has none (back-channel logout);
// - Node's bare 400, as before, for a route whose contract has no 400.
// Every other parse error keeps Node's own answer (node:_http_server
// socketOnError), byte for byte. The connection always closes, as Node's does.
import { randomUUID } from "node:crypto";
import { maxHeaderSize, STATUS_CODES } from "node:http";
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

// A refused head is at most maxHeaderSize bytes (else 431), so its request
// line is within this many bytes before the error.
const TAIL_BYTES = maxHeaderSize;

// A request line; the last one before the error is the refused request's.
const REQUEST_LINE = /([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/gu;

export type RequestLine = { readonly method: string; readonly path: string };

/** What the refused request gets: a JSON body, no body, or Node's bare 400. */
export type ContentLengthAnswer =
  | { readonly kind: "json"; readonly body: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "node" };

const head = (status: number, headers: readonly string[]): string =>
  [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, ...headers, "", ""].join("\r\n");

/** The 400 of this answer with its own request id and the security headers. */
export function contentLengthAnswer(answer: ContentLengthAnswer, requestId: string): string {
  if (answer.kind === "node") return head(400, ["Connection: close"]);
  const text = answer.kind === "json" ? JSON.stringify(answer.body) : "";
  return (
    head(400, [
      ...SECURITY_HEADERS.map(({ key, value }) => `${key}: ${value}`),
      `${REQUEST_ID_HEADER}: ${requestId}`,
      ...(answer.kind === "json" ? ["Content-Type: application/json; charset=utf-8"] : []),
      `Content-Length: ${Buffer.byteLength(text)}`,
      "Connection: close",
    ]) + text
  );
}

/**
 * The method and path of the last request line in the bytes before the
 * error, or null. Bytes a client sent choose only the shape of its own 400.
 */
export function lastRequestLine(bytes: Buffer): RequestLine | null {
  const last = [...bytes.toString("latin1").matchAll(REQUEST_LINE)].at(-1);
  return last?.[1] !== undefined && last[2] !== undefined
    ? { method: last[1], path: last[2] }
    : null;
}

/** The answer the route of this request line has for a bad Content-Length. */
export function contentLengthAnswerOf(
  routes: readonly Route[],
  line: RequestLine | null,
  requestId: string,
): ContentLengthAnswer {
  const problem = { kind: "json", body: problemOf(400, "content_length_invalid", requestId) };
  const route = routes.find(
    (r) => r.contract.method === line?.method && r.contract.path === line.path.split("?")[0],
  );
  if (route === undefined) return problem as ContentLengthAnswer;
  const refusals = route.contract.errors.filter((e) => e.status === 400);
  const spec = refusals.find((e) => e.code === "content_length_invalid") ?? refusals[0];
  if (spec === undefined) return { kind: "node" };
  if (spec.body === "none") return { kind: "empty" };
  if (spec.code === "content_length_invalid" || typeof spec.body !== "object") {
    return problem as ContentLengthAnswer;
  }
  return { kind: "json", body: { status: spec.code } };
}

/** True while an answer of this socket has written its head (Node's own check). */
function answerStarted(socket: Socket): boolean {
  const message: unknown = Reflect.get(socket, "_httpMessage");
  return (
    typeof message === "object" && message !== null && Reflect.get(message, "_headerSent") === true
  );
}

/**
 * The connection and clientError listeners of the server. A connection's
 * last TAIL_BYTES are kept, so a request line that came in an earlier packet
 * than the refused header is still found. As Node, an answer is written only
 * when none on this socket has started, then the socket is destroyed.
 */
export function createClientErrorListeners(routes: readonly Route[]): {
  connection: (socket: Socket) => void;
  clientError: (error: Error, socket: Socket) => void;
} {
  const tails = new WeakMap<Socket, Buffer>();
  return {
    connection: (socket) => {
      socket.on("data", (chunk: Buffer) => {
        const before = tails.get(socket);
        const joined =
          before === undefined || chunk.length >= TAIL_BYTES
            ? chunk
            : Buffer.concat([before, chunk]);
        tails.set(socket, Buffer.from(joined.subarray(-TAIL_BYTES)));
      });
    },
    clientError: (error, socket) => {
      if (socket.writable && !answerStarted(socket)) {
        const code = (error as { code?: unknown }).code;
        const name = typeof code === "string" ? code : "";
        if (CONTENT_LENGTH_ERRORS.has(name)) {
          // Node's listener ran first, so the tail ends before this packet.
          const { rawPacket, bytesParsed } = error as {
            rawPacket?: unknown;
            bytesParsed?: unknown;
          };
          const packet = Buffer.isBuffer(rawPacket) ? rawPacket : Buffer.alloc(0);
          const end = typeof bytesParsed === "number" ? bytesParsed : packet.length;
          const seen = Buffer.concat([
            tails.get(socket) ?? Buffer.alloc(0),
            packet.subarray(0, end),
          ]);
          const id = randomUUID();
          socket.write(
            contentLengthAnswer(contentLengthAnswerOf(routes, lastRequestLine(seen), id), id),
          );
        } else {
          socket.write(head(NODE_STATUS.get(name) ?? 400, ["Connection: close"]));
        }
      }
      socket.destroy(error);
    },
  };
}
