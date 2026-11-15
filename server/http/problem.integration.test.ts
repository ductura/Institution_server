// S-1L.3 (DAN-789) on a real server: every refusal is a problem body with an
// id the server made, the client cannot choose it, and a failing handler gives
// nothing of its error (message, stack, SQL) but the problem of 500 internal.
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messageKeyOf, REQUEST_ID_PATTERN, ROUTES } from "../contracts/index.ts";
import { createDatabases } from "./databases.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { problemOf, sendProblem } from "./problem.ts";
import { type Route, sendJson } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.invalid";
const CANARY = "made-up-canary-5c1d";
const FORGED = "11111111-1111-4111-8111-111111111111";
const UUID_V4 = new RegExp(REQUEST_ID_PATTERN, "u");

const ready = ROUTES.find((route) => route.id === "platform.ready.get");
if (ready === undefined) throw new Error("no contract");
// A handler that fails the way a database call would: SQL and a stack in the error.
const failing: Route = {
  contract: ready,
  handle: async () => {
    const failure = new Error(`syntax error at or near "${CANARY}"`);
    failure.stack = `error: select * from ${CANARY}\n    at /srv/${CANARY}.ts:1:1`;
    Object.assign(failure, { query: `select '${CANARY}'`, detail: CANARY, code: "42601" });
    throw failure;
  },
};

const status = ROUTES.find((route) => route.id === "platform.status.get");
if (status === undefined) throw new Error("no contract");
// Handlers that try to answer an error around sendProblem or to leave their
// own state on its answer (napadački prolaz, DAN-789 b); ?case= picks one.
const CASES: Record<string, Route["handle"]> = {
  length: async (_, r) => (r.setHeader("Content-Length", "3"), sendProblem(r, 404, "not_found")),
  encoding: async (_, r) => (
    r.setHeader("Content-Encoding", "gzip"),
    sendProblem(r, 404, "not_found")
  ),
  leftovers: async (_, r) => {
    r.setHeader("Set-Cookie", `s=${CANARY}`);
    r.setHeader("Location", `https://${CANARY}.invalid/`);
    r.setHeader("Trailer", "x-t");
    r.addTrailers({ "x-t": CANARY });
    r.statusMessage = CANARY;
    sendProblem(r, 404, "not_found");
  },
  writeHead: async (_, r) => {
    r.writeHead(403, { "content-type": "application/json" });
    r.end(JSON.stringify({ error: "forbidden", detail: CANARY }));
  },
  statusCode: async (_, r) => {
    r.statusCode = 404;
    r.end(JSON.stringify({ error: CANARY }));
  },
  sendJson399: async (_, r) => sendJson(r, 399, { error: CANARY }),
  sendJson204: async (_, r) => sendJson(r, 204, { error: CANARY }),
};
const scenarios: Route = {
  contract: status,
  handle: async (request, response) => {
    const name = new URL(request.url ?? "/", "http://x.invalid").searchParams.get("case") ?? "";
    await CASES[name]?.(request, response);
  },
};

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [HEALTH_ROUTE, failing, scenarios],
    databases: createDatabases(),
  });
});
afterAll(() => server.close());

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

async function refusal(path: string, init: RequestInit = {}) {
  const response = await fetch(url(path), init);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("problem bodies on the wire", () => {
  it.each([
    ["404", "/api/v1/nope", {}, 404, "not_found"],
    [
      "405",
      "/api/v1/health",
      { method: "DELETE", headers: { origin: ORIGIN } },
      405,
      "method_not_allowed",
    ],
  ] as const)(
    "%s has exactly the four fields and v1's error",
    async (_, path, init, status, code) => {
      const { response, body } = await refusal(path, init);
      expect(response.status).toBe(status);
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "error",
        "messageKey",
        "requestId",
        "status",
      ]);
      expect(body).toMatchObject({ code, error: code, messageKey: messageKeyOf(code), status });
      expect(body["requestId"]).toMatch(UUID_V4);
      expect(response.headers.get("x-request-id")).toBe(body["requestId"]);
    },
  );

  it("403 is a oneOf in v1: exactly {error}, the server's id only in X-Request-Id", async () => {
    const { response, body } = await refusal("/api/v1/health", {
      method: "POST",
      headers: { "x-request-id": FORGED },
    });
    expect([response.status, body]).toEqual([403, { error: "origin_missing" }]);
    expect(response.headers.get("x-request-id")).toMatch(UUID_V4);
    expect(response.headers.get("x-request-id")).not.toBe(FORGED);
  });

  it("never takes the request id from the client", async () => {
    const forged = { "x-request-id": FORGED, "request-id": FORGED, "x-correlation-id": FORGED };
    const { response, text, body } = await refusal(`/api/v1/nope?requestId=${FORGED}`, {
      headers: forged,
    });
    expect(text).not.toContain(FORGED);
    expect(body["requestId"]).toMatch(UUID_V4);
    expect(response.headers.get("x-request-id")).toBe(body["requestId"]);
  });

  it("gives each request an id of its own", async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, async () => (await refusal("/api/v1/nope")).body["requestId"]),
    );
    expect(new Set(ids).size).toBe(20);
  });

  it("a failing handler: 500 internal, no message, stack or SQL, the id in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { response, text, body } = await refusal("/api/v1/ready");
      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: "internal",
        code: "internal",
        messageKey: "errors.internal",
        status: 500,
        requestId: response.headers.get("x-request-id"),
      });
      for (const leak of [CANARY, "select", "syntax", "42601", "/srv/", "at "]) {
        expect(text).not.toContain(leak);
      }
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(CANARY);
      expect(logged).toContain(String(body["requestId"]));
    } finally {
      log.mockRestore();
    }
  });

  it("a success answer is unchanged: no request id", async () => {
    const response = await fetch(url("/api/v1/health"));
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeNull();
  });
});

describe("a handler cannot answer an error around sendProblem", () => {
  it.each(["writeHead", "statusCode", "sendJson399", "sendJson204"])(
    "%s: 500 internal, nothing of the handler's body",
    async (name) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { response, text, body } = await refusal(`/api/v1/status?case=${name}`);
        expect(response.status).toBe(500);
        expect(text).not.toContain(CANARY);
        expect(body).toEqual(problemOf(500, "internal", String(body["requestId"])));
        expect(response.headers.get("x-request-id")).toBe(body["requestId"]);
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("sendProblem drops what the handler set before it", () => {
  it.each(["length", "encoding"])("%s: the problem body arrives whole", async (name) => {
    const { response, body } = await refusal(`/api/v1/status?case=${name}`);
    expect(response.status).toBe(404);
    expect(body).toEqual(problemOf(404, "not_found", String(body["requestId"])));
  });

  it("no cookie, location, trailer or status text of the handler", async () => {
    const socket = connect(server.port, "127.0.0.1");
    socket.write(
      "GET /api/v1/status?case=leftovers HTTP/1.1\r\nHost: x\r\nTE: trailers\r\nConnection: close\r\n\r\n",
    );
    let raw = "";
    for await (const chunk of socket) raw += String(chunk);
    expect(raw).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/u);
    expect(raw).not.toContain(CANARY);
    expect(raw.toLowerCase()).not.toMatch(/set-cookie|location:|trailer/u);
    expect(raw).toMatch(/X-Frame-Options: DENY/u);
  });
});
