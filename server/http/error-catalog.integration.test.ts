// S-1M-c (DAN-802) on the wire: a handler or a layer that throws gives the
// contract's 500 internal, a body that passes the INTERNAL schema, and one
// server_error record with the request id the answer carries. Nothing of the
// error or of the request (body, URL, headers) reaches the answer or the log.
import { request as httpRequest } from "node:http";

import { Value } from "@sinclair/typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { INTERNAL } from "../contracts/index.ts";
import { createDatabases } from "./databases.ts";
import { createHealthRoute } from "./health.ts";
import { createLayers, type Layer } from "./pipeline.ts";
import type { Handler } from "./router.ts";
import { createShutdownCoordinator } from "./shutdown.ts";
import { type Running, startServer } from "./start.ts";

const CANARY = "made-up-canary-91c4";

const HEALTH_ROUTE = createHealthRoute({
  health: async () => ({ main: "ok", logs: "ok", legal: "ok" }),
  serverVersion: "0.0.0",
});

class Leaky extends Error {
  override name = `Leaky ${CANARY}`;
}

// The handler throws whatever the request asks for; every value carries the canary.
const THROWN: Record<string, () => unknown> = {
  error: () => new Error(CANARY, { cause: CANARY }),
  subclass: () => new Leaky(CANARY),
  type: () => new TypeError(CANARY),
  string: () => CANARY,
  object: () => ({ message: CANARY, stack: CANARY }),
};

const handle: Handler = async (request) => {
  const pick = new URL(request.url ?? "", "http://x.invalid").searchParams.get("throw") ?? "";
  if (pick === "body") {
    // The body is read into memory and thrown back in every way it could leak.
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    throw new Error(text, { cause: text });
  }
  const make = THROWN[pick];
  if (make !== undefined) throw make();
};

const throwingLayer: Layer = async (request) => {
  if ((request.url ?? "").includes("layer")) throw new RangeError(CANARY);
  return "next";
};

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: { ...createLayers({ expectedOrigin: null }), originCheck: throwingLayer },
    databases: createDatabases(),
    shutdown: createShutdownCoordinator({ graceMs: 1_000 }),
    routes: [{ contract: HEALTH_ROUTE.contract, handle }],
  });
});
afterAll(() => server.closeAllConnections());
afterEach(() => vi.restoreAllMocks());

type Wire = { status: number; headers: Record<string, unknown>; body: string };

function get(path: string, body?: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        // GET even with a body: the one route is GET, so the handler runs and
        // reads it (a POST would stop at 405 before the handler).
        method: "GET",
        path,
        headers: {
          "x-debug": CANARY,
          cookie: `s=${CANARY}`,
          "user-agent": CANARY,
          // A GET is not chunked by default; the length frames the body.
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function captureConsole(): () => string[] {
  const all = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  return () => all.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")));
}

const records = (lines: string[]) =>
  lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === "server_error");

describe("an uncaught error on the wire", () => {
  it.each([
    ["error", "other"],
    ["subclass", "other"],
    ["type", "type_error"],
    ["string", "other"],
    ["object", "other"],
  ])("a handler throwing %s gives 500 internal and server_error (%s)", async (pick, errorClass) => {
    const read = captureConsole();
    const wire = await get(`/api/v1/health?throw=${pick}&q=${CANARY}`);
    expect(wire.status).toBe(500);
    const body = JSON.parse(wire.body) as unknown;
    expect(Value.Check(INTERNAL.error.body as never, body)).toBe(true);
    const requestId = wire.headers["x-request-id"];
    expect(body).toEqual({
      error: "internal",
      code: "internal",
      messageKey: "errors.internal",
      status: 500,
      requestId,
    });
    expect(records(read())).toEqual([
      {
        event: "server_error",
        where: "route",
        errorClass,
        requestId,
        route: "platform.health.get",
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain(CANARY);
    expect(read().join("\n")).not.toContain(CANARY);
  });

  it("a layer that throws gives 500 internal and server_error at the layer", async () => {
    const read = captureConsole();
    const wire = await get(`/api/v1/health?layer=${CANARY}`);
    expect(wire.status).toBe(500);
    expect(Value.Check(INTERNAL.error.body as never, JSON.parse(wire.body))).toBe(true);
    expect(records(read())).toEqual([
      {
        event: "server_error",
        where: "layer",
        errorClass: "range_error",
        requestId: wire.headers["x-request-id"],
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain(CANARY);
    expect(read().join("\n")).not.toContain(CANARY);
  });

  it("a handler that read the body and threw leaks no part of it", async () => {
    const read = captureConsole();
    const wire = await get("/api/v1/health?throw=body", JSON.stringify({ text: CANARY }));
    expect(wire.status).toBe(500);
    expect(Value.Check(INTERNAL.error.body as never, JSON.parse(wire.body))).toBe(true);
    expect(records(read())).toEqual([
      {
        event: "server_error",
        where: "route",
        errorClass: "other",
        requestId: wire.headers["x-request-id"],
        route: "platform.health.get",
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain(CANARY);
    expect(read().join("\n")).not.toContain(CANARY);
  });
});
