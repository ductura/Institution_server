// What a request gets when Node's parser refuses it, before any layer runs
// (DAN-851-1d3a, Ductus#1836 c.6940996486, decision c.6941043545). The first
// request on a connection whose Content-Length the parser refuses gets the
// 400 its route's contract has, chosen by its own first line only:
// - the problem body content_length_invalid (MUTATION_GUARD, unknown path);
// - {status: code} where the 400 is a refusal body (evidence);
// - no body where the 400 has none (back-channel logout);
// - Node's bare 400 where the contract has no JSON 400.
// A later request on the connection, and every other parse error, keep
// Node's own answer byte for byte: a shaped 400 while an earlier request is
// unanswered would be read as that request's answer.
import { randomUUID } from "node:crypto";
import { type IncomingMessage, maxHeaderSize, STATUS_CODES } from "node:http";
import type { Socket } from "node:net";

import { problemOf } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import { type Route, routePath } from "./router.ts";
import { SECURITY_HEADERS } from "./security-header-values.ts";

/** Parser errors of the declared length: not a decimal, repeated, or beside Transfer-Encoding. */
const CONTENT_LENGTH_ERRORS: ReadonlySet<string> = new Set([
  "HPE_INVALID_CONTENT_LENGTH",
  "HPE_UNEXPECTED_CONTENT_LENGTH",
]);

/** Node's own status for the parse errors it does not answer 400 (_http_server socketOnError). */
const NODE_STATUS: ReadonlyMap<string, number> = new Map([
  ["HPE_HEADER_OVERFLOW", 431],
  ["HPE_CHUNK_EXTENSIONS_OVERFLOW", 413],
  ["ERR_HTTP_REQUEST_TIMEOUT", 408],
]);

const statusLine = (status: number) => `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`;
const nodeAnswer = (status: number) => `${statusLine(status)}\r\nConnection: close\r\n\r\n`;

export type RequestLine = { readonly method: string; readonly path: string | null };

/**
 * The method and path of the first request line in these bytes, as llhttp
 * reads it: leading CR and LF skipped, fields split on runs of spaces, the
 * path as the router reads it (null when it is none). Null without a line.
 */
export function firstRequestLine(bytes: Buffer): RequestLine | null {
  const text = bytes.toString("latin1").replace(/^[\r\n]+/u, "");
  const end = text.indexOf("\r\n");
  if (end < 0) return null;
  const [method, target, version, ...rest] = text.slice(0, end).split(/ +/u);
  if (!method || !target || !version?.startsWith("HTTP/") || rest.length > 0) return null;
  return { method, path: routePath(target) ?? null };
}

/** The answer the route of this line has for a refused Content-Length. */
function answerOf(routes: readonly Route[], line: RequestLine, requestId: string): string {
  const route = routes.find(
    (r) => r.contract.method === line.method && r.contract.path === line.path,
  );
  const refusals = route?.contract.errors.filter((e) => e.status === 400) ?? [];
  const spec = refusals.find((e) => e.code === "content_length_invalid") ?? refusals[0];
  let body: unknown = problemOf(400, "content_length_invalid", requestId);
  if (route !== undefined && spec?.code !== "content_length_invalid") {
    if (spec?.body === "none") body = undefined;
    else if (typeof spec?.body === "object") body = { status: spec.code };
    else return nodeAnswer(400);
  }
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers = [
    ...SECURITY_HEADERS.map(({ key, value }) => `${key}: ${value}`),
    `${REQUEST_ID_HEADER}: ${requestId}`,
    ...(body === undefined ? [] : ["Content-Type: application/json; charset=utf-8"]),
    `Content-Length: ${Buffer.byteLength(text)}`,
    "Connection: close",
  ];
  return `${[statusLine(400), ...headers].join("\r\n")}\r\n\r\n${text}`;
}

/** True while an answer on this socket has written its head (Node's own check). */
function answerStarted(socket: Socket): boolean {
  const message: unknown = Reflect.get(socket, "_httpMessage");
  return (
    typeof message === "object" && message !== null && Reflect.get(message, "_headerSent") === true
  );
}

type First = {
  chunks: Buffer[];
  /** Bytes kept from the first byte that is not CR or LF. */
  kept: number;
  /** Every byte the connection received, kept or not. */
  seen: number;
  first: boolean;
  /** A byte after the first line's start was dropped: the line cannot be trusted. */
  cut: boolean;
};

const isLineBreak = (byte: number) => byte === 0x0d || byte === 0x0a;

/**
 * The connection, request and clientError listeners of the server. Until its
 * first request, a connection's bytes (at most maxHeaderSize) are kept, so the
 * first line is read whatever the packets. They count only when they end
 * exactly where the refused packet starts; any other listener order is the
 * bare 400.
 */
export function createClientErrorListeners(routes: readonly Route[]): {
  connection: (socket: Socket) => void;
  request: (request: IncomingMessage) => void;
  clientError: (error: Error, socket: Socket) => void;
} {
  const states = new WeakMap<Socket, First>();
  return {
    connection: (socket) => {
      const state: First = { chunks: [], kept: 0, seen: 0, first: true, cut: false };
      states.set(socket, state);
      socket.on("data", (chunk: Buffer) => {
        state.seen += chunk.length;
        if (!state.first || state.cut) return;
        // Leading CR and LF are skipped by llhttp outside the head's budget, so
        // they are not kept: the cap counts only bytes from the first line on.
        let part = chunk;
        if (state.kept === 0) {
          let start = 0;
          while (start < part.length && isLineBreak(part[start] ?? 0)) start += 1;
          part = part.subarray(start);
        }
        if (state.kept + part.length > maxHeaderSize) state.cut = true;
        else if (part.length > 0) {
          state.chunks.push(part);
          state.kept += part.length;
        }
      });
    },
    request: (request) => {
      const state = states.get(request.socket);
      if (state === undefined) return;
      state.first = false;
      state.chunks = [];
    },
    clientError: (error, socket) => {
      if (socket.writable && !answerStarted(socket)) {
        const { code, rawPacket, bytesParsed } = error as {
          code?: unknown;
          rawPacket?: unknown;
          bytesParsed?: unknown;
        };
        const name = typeof code === "string" ? code : "";
        const packet = Buffer.isBuffer(rawPacket) ? rawPacket : Buffer.alloc(0);
        const state = states.get(socket);
        let answer = nodeAnswer(NODE_STATUS.get(name) ?? 400);
        // First: no request event, nothing written (Node's own 417 or 100
        // Continue answer a head without one) and no answer assigned.
        if (
          CONTENT_LENGTH_ERRORS.has(name) &&
          state?.first === true &&
          !state.cut &&
          socket.bytesWritten === 0 &&
          Reflect.get(socket, "_httpMessage") == null &&
          state.seen === socket.bytesRead - packet.length
        ) {
          const end = typeof bytesParsed === "number" ? bytesParsed : packet.length;
          const line = firstRequestLine(Buffer.concat([...state.chunks, packet.subarray(0, end)]));
          if (line !== null) answer = answerOf(routes, line, randomUUID());
        }
        socket.write(answer);
      }
      socket.destroy(error);
    },
  };
}
