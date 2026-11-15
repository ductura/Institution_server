// The contract's 500 internal (DAN-776) from a real node:http server, as a
// client reads it off the wire. Each case is a failure the adversarial pass
// on 302f6e7 turned into a leak, a desync, a cut answer or a process exit.
import { connect } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { sendJson } from "./json.ts";
import { createLayers, type Layer } from "./pipeline.ts";
import type { Handler } from "./router.ts";
import { createShutdownCoordinator } from "./shutdown.ts";
import { type Running, startServer } from "./start.ts";

const CANARY = "made-up-canary-7f3a";
const BIG = 4 * 1024 * 1024;

const handlers: Record<string, Handler> = {
  "/status": async (_request, response) => {
    // An invalid status line makes writeHead itself throw (ERR_INVALID_CHAR).
    response.statusMessage = "a\nb";
    throw new Error(CANARY);
  },
  "/headers": async (_request, response) => {
    response.statusMessage = `db ${CANARY} down`;
    response.setHeader("x-debug", CANARY);
    response.setHeader("content-length", "3");
    throw new Error(CANARY);
  },
  "/trailers": async (_request, response) => {
    response.addTrailers({ "x-debug": CANARY });
    throw new Error(CANARY);
  },
  "/finished": async (_request, response) => {
    sendJson(response, 200, { status: "x".repeat(BIG) });
    throw new Error(CANARY);
  },
};

// Routes are chosen by contract path; this test routes by a query instead.
const route: Handler = async (request, response) => {
  const pick = new URL(request.url ?? "", "http://x.invalid").searchParams.get("case") ?? "";
  const handle = handlers[`/${pick}`];
  if (handle === undefined) return HEALTH_ROUTE.handle(request, response);
  return handle(request, response);
};

const failingLayer: Layer = async (request, response) => {
  if (!(request.url ?? "").includes("layer")) return "next";
  response.statusMessage = `layer ${CANARY}`;
  response.setHeader("x-debug", CANARY);
  return "garbage" as "next";
};

let server: Running;
const exits: unknown[] = [];
const onRejection = (reason: unknown) => exits.push(reason);

beforeAll(async () => {
  process.on("unhandledRejection", onRejection);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: { ...createLayers({ expectedOrigin: null }), originCheck: failingLayer },
    databases: createDatabases(),
    shutdown: createShutdownCoordinator({ graceMs: 1_000 }),
    routes: [{ contract: HEALTH_ROUTE.contract, handle: route }],
  });
});
afterAll(() => {
  process.off("unhandledRejection", onRejection);
  server.closeAllConnections();
});
afterEach(() => vi.restoreAllMocks());

/** Raw bytes for one or more pipelined requests, until the server closes or goes quiet. */
function exchange(raw: string, quietMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(server.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let timer = setTimeout(() => socket.destroy(), quietMs);
    const done = () => resolve(Buffer.concat(chunks).toString("latin1"));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), quietMs);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      done();
    });
    socket.write(raw);
  });
}
const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
// The problem body of 500 internal (S-1L.3), with the id the header of the
// same answer names: an answer without a well-formed X-Request-Id never matches.
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** The 500 internal problem this wire should carry, by the id in its X-Request-Id. */
function internalOf(wire: string): string {
  const id = new RegExp(`\r\nx-request-id: (${UUID_V4})\r\n`, "iu").exec(wire)?.[1] ?? "none";
  return `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"${id}"}`;
}

/**
 * One answer framed by itself: the body after the head is exactly as long as
 * its Content-Length (writeJson states it), never chunked, nothing after it.
 */
function bodyOf(wire: string): string | undefined {
  const at = wire.indexOf("\r\n\r\n");
  const [head, body] = [wire.slice(0, at), wire.slice(at + 4)];
  const length = /\r\ncontent-length: (\d+)\r?$/imu.exec(head)?.[1];
  if (/transfer-encoding/iu.test(head) || Number(length) !== Buffer.byteLength(body))
    return undefined;
  return body;
}

describe("500 internal on the wire", () => {
  it("a failing 500 itself cuts the connection and never exits the process", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wire = await exchange(get("/api/v1/health?case=status"));
    expect(wire === "" || wire.startsWith("HTTP/1.1 500 Internal Server Error\r\n")).toBe(true);
    expect(wire).not.toContain(CANARY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toEqual([]);
    expect(await exchange(get("/api/v1/health"))).toMatch(/^HTTP\/1\.1 200 OK/u);
  });

  it("drops the status line and headers a handler set, closes, so nothing desyncs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wire = await exchange(get("/api/v1/health?case=headers") + get("/api/v1/health"));
    expect(wire.startsWith("HTTP/1.1 500 Internal Server Error\r\n")).toBe(true);
    expect(wire).not.toContain(CANARY);
    expect(wire).toMatch(/\r\nconnection: close\r\n/iu);
    expect(wire).not.toMatch(/content-length: 3\r\n/iu);
    // One answer, framed by itself; the pipelined second request is never read.
    expect(bodyOf(wire)).toBe(internalOf(wire));
    expect(wire.match(/HTTP\/1\.1 /gu)).toHaveLength(1);
  });

  it("drops the trailers a failed handler added", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wire = await exchange(get("/api/v1/health?case=trailers"));
    expect(wire.startsWith("HTTP/1.1 500 Internal Server Error\r\n")).toBe(true);
    expect(wire).not.toContain(CANARY);
    expect(bodyOf(wire)).toBe(internalOf(wire));
  });

  it("a layer's garbage outcome keeps nothing it set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wire = await exchange(get("/api/v1/health?layer=1"));
    expect(wire.startsWith("HTTP/1.1 500 Internal Server Error\r\n")).toBe(true);
    expect(wire).not.toContain(CANARY);
    expect(bodyOf(wire)).toBe(internalOf(wire));
  });

  it("a throw after a finished answer lets the whole body arrive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wire = await exchange(get("/api/v1/health?case=finished"), 1_000);
    expect(wire.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(bodyOf(wire)).toMatch(/"\}$/u);
    expect(wire.length).toBeGreaterThan(BIG);
  });
});
