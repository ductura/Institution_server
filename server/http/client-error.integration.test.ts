// DAN-851-1d3a (Ductus#1836 c.6940996486, decision c.6941043545): the first
// request on a connection whose Content-Length Node's parser refuses gets the
// 400 its route's contract has, chosen by its own first line only; a later
// request and any other parse error keep Node's bare answer. Over a real
// socket of startServer; every value is invented.
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";

import { createClientErrorListeners, firstRequestLine } from "./client-error.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { SECURITY_HEADERS } from "./security-header-values.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.example.invalid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BARE = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const LOCALE = "/api/v1/profile/interface-locale";
const EVIDENCE = "/api/v1/evidence/open";
const BACKCHANNEL = "/api/v1/auth/backchannel-logout";

let handled = 0;
const route = (id: string): Route => ({
  contract: ROUTES.find((r) => r.id === id)!,
  handle: async (_request, response) => {
    handled += 1;
    response.writeHead(204).end();
  },
});
const ROUTE_LIST = [
  ...["profile.interface-locale.post", "evidence.open.post", "auth.backchannel-logout.post"],
  ...["auth.logout.post", "auth.callback.get"],
].map(route);

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: ROUTE_LIST,
  });
});
afterAll(async () => server.close());

/** Every byte the server sends before it closes, the chunks sent 15 ms apart. */
function exchange(chunks: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1", async () => {
      for (const chunk of chunks) {
        if (socket.destroyed) break;
        socket.write(chunk);
        await new Promise((r) => setTimeout(r, 15));
      }
    });
    let text = "";
    socket.on("data", (data) => (text += data.toString("latin1")));
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

const head = (path: string, length: string, method = "POST", extra = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: x\r\n${extra}Content-Length: ${length}\r\n\r\n`;

function parse(text: string) {
  const [top = "", body = ""] = text.split("\r\n\r\n");
  const [line = "", ...rest] = top.split("\r\n");
  const headers = Object.fromEntries(
    rest.map((h) => [h.slice(0, h.indexOf(":")).toLowerCase(), h.slice(h.indexOf(":") + 2)]),
  );
  return { line, headers, body };
}
const json = (text: string): unknown => JSON.parse(parse(text).body);
const PROBLEM = expect.objectContaining({ code: "content_length_invalid", status: 400 });

describe("a header or a body never chooses the route", () => {
  it("a header that imitates a request line is not the first line", async () => {
    const spoof = `X-Note: POST ${BACKCHANNEL} HTTP/1.1\r\n`;
    expect(json(await exchange([head(LOCALE, "-1", "POST", spoof)]))).toEqual(PROBLEM);
    const evidence = await exchange([head(EVIDENCE, "-1", "POST", spoof)]);
    expect(json(evidence)).toEqual({ status: "bad_request" });
  });

  it("a request after the first on the connection keeps Node's bare 400", async () => {
    // Pipelined: the first is not answered yet; a shaped 400 would read as its answer.
    const pipelined = await exchange([`${head(LOCALE, "0")}${head(BACKCHANNEL, "-1")}`]);
    expect(pipelined.endsWith(BARE)).toBe(true);
    expect(pipelined).not.toContain("Content-Length: 0\r\nConnection: close");
    // Keep-alive: the first was answered in an earlier packet.
    const second = await exchange([
      `GET /api/v1/nowhere HTTP/1.1\r\nHost: x\r\n\r\n`,
      head(EVIDENCE, "-1"),
    ]);
    expect(second.endsWith(BARE)).toBe(true);
    expect(second).not.toContain("bad_request");
  });
});

describe("the first request's 400 is its route's", () => {
  it("however its bytes are split into packets", async () => {
    const whole = head(EVIDENCE, "-1");
    for (const chunks of [
      [whole.slice(0, 30), whole.slice(30)],
      [whole.slice(0, 9), whole.slice(9, 14), whole.slice(14)],
      [...whole],
    ])
      expect([chunks.length, json(await exchange(chunks))]).toEqual([
        chunks.length,
        { status: "bad_request" },
      ]);
  });

  it("after CR and LF before the line, and with runs of spaces in it", async () => {
    for (const before of ["\r\n", "\n", "\r\n\r\n", "\r\r\n\n\r"])
      expect(json(await exchange([`${before}${head(EVIDENCE, "1x")}`]))).toEqual({
        status: "bad_request",
      });
    const spaced = `POST  ${EVIDENCE}  HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n`;
    expect(json(await exchange([spaced]))).toEqual({ status: "bad_request" });
  });

  it("is the problem with its headers, the request id the body's", async () => {
    const { line, headers, body } = parse(await exchange([head(LOCALE, "-1")]));
    expect(line).toBe("HTTP/1.1 400 Bad Request");
    const id = headers["x-request-id"] ?? "";
    expect(id).toMatch(UUID);
    expect(JSON.parse(body)).toEqual({
      error: "content_length_invalid",
      code: "content_length_invalid",
      messageKey: "errors.contentLengthInvalid",
      status: 400,
      requestId: id,
    });
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(headers["connection"]).toBe("close");
    for (const { key, value } of SECURITY_HEADERS) expect(headers[key.toLowerCase()]).toBe(value);
    expect(handled).toBe(0);
  });

  it("has no body where the 400 has none, and is bare where the contract has no JSON 400", async () => {
    const { line, headers, body } = parse(await exchange([head(BACKCHANNEL, "-1")]));
    expect([line, body, headers["content-length"], headers["content-type"]]).toEqual([
      "HTTP/1.1 400 Bad Request",
      "",
      "0",
      undefined,
    ]);
    expect(headers["x-request-id"]).toMatch(UUID);
    expect(await exchange([head("/api/v1/auth/logout", "-1")])).toBe(BARE);
    expect(await exchange([head("/api/v1/auth/callback", "-1", "GET")])).toBe(BARE);
  });

  it("an unknown path, another method or a query keep to the router's reading", async () => {
    expect(json(await exchange([head("/api/v1/nowhere", "-1")]))).toEqual(PROBLEM);
    expect(json(await exchange([head(EVIDENCE, "-1", "PUT")]))).toEqual(PROBLEM);
    expect(json(await exchange([head(`${EVIDENCE}?x=1`, "-1")]))).toEqual({
      status: "bad_request",
    });
    expect(json(await exchange([head(`/api/v1//evidence/open`, "-1")]))).toEqual(PROBLEM);
  });

  it("covers every length the parser refuses this way", async () => {
    for (const length of ["-1", "abc", "1x", "+5", "1, 2"])
      expect([length, json(await exchange([head(EVIDENCE, length)]))]).toEqual([
        length,
        { status: "bad_request" },
      ]);
    for (const extra of [
      "Content-Length: 2\r\n",
      "Content-Length: 3\r\n",
      "Transfer-Encoding: chunked\r\n",
    ])
      expect([extra, json(await exchange([head(EVIDENCE, "3", "POST", extra)]))]).toEqual([
        extra,
        { status: "bad_request" },
      ]);
    // The other order is Node's HPE_INVALID_TRANSFER_ENCODING: bare, a known bound.
    const reversed = `POST ${EVIDENCE} HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n`;
    expect(await exchange([reversed])).toBe(BARE);
  });
});

describe("any other parse error", () => {
  it("keeps Node's own answer byte for byte", async () => {
    expect(await exchange([`POST ${EVIDENCE} HTTP/1.1\r\nHost: x\r\nCookie: a\x01b\r\n\r\n`])).toBe(
      BARE,
    );
    expect(
      await exchange([`GET /x HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`]),
    ).toBe("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
    expect(await exchange(["NOT A REQUEST\r\n\r\n"])).toBe(BARE);
  });
});

describe("the listeners on their own", () => {
  type Fake = EventEmitter & { bytesRead: number; writable: boolean; written: string[] };
  const fake = (): Fake =>
    Object.assign(new EventEmitter(), {
      bytesRead: 0,
      writable: true,
      written: [] as string[],
      write(text: string) {
        this.written.push(text);
        return true;
      },
      destroy() {},
    });
  const refused = (packet: string) =>
    Object.assign(new Error("parse"), {
      code: "HPE_INVALID_CONTENT_LENGTH",
      rawPacket: Buffer.from(packet, "latin1"),
      bytesParsed: packet.length,
    });

  it("trust the kept bytes only when they end where the refused packet starts", () => {
    const listeners = createClientErrorListeners(ROUTE_LIST);
    const kept = `POST ${EVIDENCE} HTTP/1.1\r\n`;
    const packet = "Host: x\r\nContent-Length: -1\r\n\r\n";
    for (const [bytesRead, shaped] of [
      [kept.length + packet.length, true],
      [packet.length, false], // a listener saw nothing the parser read
      [kept.length + packet.length + 5, false],
    ] as const) {
      const socket = fake();
      listeners.connection(socket as unknown as Socket);
      socket.emit("data", Buffer.from(kept, "latin1"));
      socket.bytesRead = bytesRead;
      listeners.clientError(refused(packet), socket as unknown as Socket);
      expect([bytesRead, socket.written[0]?.includes("bad_request")]).toEqual([bytesRead, shaped]);
      if (!shaped) expect(socket.written).toEqual([BARE]);
    }
  });

  it("read the first line only from the start, after CR and LF", () => {
    expect(firstRequestLine(Buffer.from(`\r\nPOST  ${EVIDENCE}  HTTP/1.1\r\nHost: x\r\n`))).toEqual(
      {
        method: "POST",
        path: EVIDENCE,
      },
    );
    expect(firstRequestLine(Buffer.from(`POST ${EVIDENCE} HTTP/1.1`))).toBeNull();
    expect(firstRequestLine(Buffer.from(`Host: x\r\nPOST ${EVIDENCE} HTTP/1.1\r\n`))).toBeNull();
  });
});
