import type { IncomingMessage, ServerResponse } from "node:http";

import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorBody, INTERNAL, messageKeyOf, ROUTES, type VectorFile } from "../contracts/index.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createRouter, errorName, type Route, routePath, sendJson } from "./router.ts";

type Answer = {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: string;
  destroyed?: boolean;
};

// A request and response with only what the router touches; no network.
function call(
  router: ReturnType<typeof createRouter>,
  method: string,
  url: string,
): Promise<Answer> {
  const answer: Answer = {};
  const set = new Map<string, string>();
  const response = {
    headersSent: false,
    writableEnded: false,
    statusMessage: "",
    setHeader: (name: string, value: string) => set.set(name.toLowerCase(), value),
    hasHeader: (name: string) => set.has(name.toLowerCase()),
    removeHeader: (name: string) => set.delete(name.toLowerCase()),
    getHeaderNames: () => [...set.keys()],
    addTrailers: () => undefined,
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      answer.statusMessage = this.statusMessage;
      answer.headers = { ...Object.fromEntries(set), ...headers };
      this.headersSent = true;
    },
    end(body?: string) {
      if (body !== undefined) answer.body = body;
      this.writableEnded = true;
    },
    destroy() {
      answer.destroyed = true;
    },
  };
  const request = { method, url } as IncomingMessage;
  return router(request, response as unknown as ServerResponse).then(() => answer);
}

/** The problem body of a contract error (S-1L.3); the request id is new each time. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const problem = (status: number, code: string) => ({
  error: code,
  code,
  messageKey: messageKeyOf(code),
  status,
  requestId: expect.stringMatching(UUID_V4),
});

const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const throwing: Route = {
  contract: contract("platform.ready.get"),
  handle: async () => {
    throw new TypeError("invented-canary-message");
  },
};

describe("createRouter", () => {
  const router = createRouter([HEALTH_ROUTE, throwing]);

  it("answers health with exactly {status: ok} and no-store, whatever the query", async () => {
    const answer = await call(router, "GET", "/api/v1/health?verbose=1");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body ?? "")).toEqual({ status: "ok" });
    expect(answer.headers?.["cache-control"]).toBe("no-store");
  });

  it.each([
    ["an unknown path", "GET", "/api/v1/nope", 404, problem(404, "not_found")],
    ["a trailing slash", "GET", "/api/v1/health/", 404, problem(404, "not_found")],
    ["an encoded path", "GET", "/api/v1/%68ealth", 404, problem(404, "not_found")],
    ["another method", "DELETE", "/api/v1/health", 405, problem(405, "method_not_allowed")],
    ["HEAD", "HEAD", "/api/v1/health", 405, problem(405, "method_not_allowed")],
  ])("refuses %s in the contract format", async (_, method, url, status, body) => {
    const answer = await call(router, method, url);
    const sent = JSON.parse(answer.body ?? "") as { requestId: string };
    expect([answer.status, sent]).toEqual([status, body]);
    expect(answer.headers?.["x-request-id"]).toBe(sent.requestId);
    if (status === 405) expect(answer.headers?.allow).toBe("GET");
  });

  // QA (adversarial pass on 8366c2e): a target WHATWG URL rejects threw before
  // the handler and answered 500; a target it rewrites reached health.
  it.each([
    "http://[::1",
    "http://",
    "*",
    "//evil.invalid/api/v1/health",
    "/api\\v1\\health",
    "/api/v2/../v1/health",
    "/api/v1/./health",
    "/api/v1/health/.",
    "api/v1/health",
  ])("answers 404 to the target %j without rewriting it", async (url) => {
    const answer = await call(router, "GET", url);
    expect([answer.status, JSON.parse(answer.body ?? "")]).toEqual([
      404,
      problem(404, "not_found"),
    ]);
  });

  it("chooses by the path as sent, without the query", () => {
    expect(routePath("/api/v1/health?a=1?b")).toBe("/api/v1/health");
    expect(routePath("/api/v1/%2e%2e/health")).toBe("/api/v1/%2e%2e/health");
    expect(routePath("/a..b/c.")).toBe("/a..b/c.");
    expect(routePath(undefined)).toBeUndefined();
  });

  it("answers 500 when a handler throws, without the error message", async () => {
    const answer = await call(router, "GET", "/api/v1/ready");
    expect([answer.status, JSON.parse(answer.body ?? "")]).toEqual([500, problem(500, "internal")]);
    expect(answer.body).not.toContain("invented-canary");
  });

  it("refuses two routes on one method and path", () => {
    expect(() => createRouter([HEALTH_ROUTE, HEALTH_ROUTE])).toThrow(/duplicate route/u);
  });
});

// DAN-776: every failing handler answers exactly the contract's 500 internal.
// The canary is a made-up string; it stands for anything from inside the server.
const CANARY = "made-up-canary-7f3a";
const HEALTH_VECTORS = JSON.parse(
  readFileSync(new URL("../contracts/vectors/platform.health.get.json", import.meta.url), "utf8"),
) as VectorFile;
const INTERNAL_VECTOR = HEALTH_VECTORS.vectors.find((v) => v.name === "internal");

/** The exact text of the 500 body: nothing but the problem fields. */
const internalText = (requestId: string): string =>
  `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"${requestId}"}`;

function leaky(): Error {
  const failure = new RangeError(`${CANARY} message /srv/${CANARY}.ts`, { cause: CANARY });
  failure.stack = `RangeError: ${CANARY}\n    at /srv/${CANARY}.ts:1:1`;
  Object.assign(failure, { detail: CANARY, sql: `select '${CANARY}'` });
  return failure;
}

const hostileName = Object.create(Error.prototype, {
  name: {
    get() {
      throw new Error(CANARY);
    },
  },
}) as unknown;
/** Made on use: the test runner itself cannot read a revoked Proxy. */
function revokedProxy(): unknown {
  const revoked = Proxy.revocable(new Error(CANARY), {});
  revoked.revoke();
  return revoked.proxy;
}
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const FAILURES: [string, () => Promise<void>][] = [
  ["an Error with the canary everywhere", () => Promise.reject(leaky())],
  ["a thrown string", () => Promise.reject(CANARY)],
  ["a thrown null", () => Promise.reject(null)],
  ["an error whose name getter throws", () => Promise.reject(hostileName)],
  ["a revoked Proxy", () => Promise.reject(revokedProxy())],
  ["a Proxy around an error", () => Promise.reject(new Proxy(leaky(), { get: () => CANARY }))],
  [
    "a rejected promise awaited later",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw leaky();
    },
  ],
];
const BODIES: [string, unknown][] = [
  ["a BigInt", { n: 1n }],
  ["a cycle", cyclic],
  [
    "a throwing toJSON",
    {
      toJSON() {
        throw leaky();
      },
    },
  ],
];

describe("createRouter on a failing handler (DAN-776)", () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failingWith = (handle: Route["handle"]) =>
    createRouter([HEALTH_ROUTE, { contract: contract("platform.ready.get"), handle }]);

  it("has the vector of 500 internal to compare with", () => {
    expect(INTERNAL_VECTOR?.response).toEqual({
      status: 500,
      contentType: "application/json",
      body: { ...problem(500, "internal"), requestId: "00000000-0000-4000-8000-000000000000" },
    });
  });

  it.each([
    ...FAILURES,
    ...BODIES.map(([what, body]): [string, () => Promise<void>] => [
      `a body with ${what}`,
      async () => sendJson({ writeHead: () => undefined } as never, 200, body),
    ]),
  ])("%s: the contract's 500, nothing from inside", async (_, fail) => {
    const log = quiet();
    const answer = await call(failingWith(fail), "GET", "/api/v1/ready");
    expect(answer.status).toBe(INTERNAL.error.status);
    const body: unknown = JSON.parse(answer.body ?? "");
    expect(Value.Check(errorBody(INTERNAL.error.code, INTERNAL.error.status), body)).toBe(true);
    const { requestId } = body as { requestId: string };
    expect(body).toEqual({ ...(INTERNAL_VECTOR?.response.body as object), requestId });
    expect(answer.body).toBe(internalText(requestId));
    expect(answer.headers?.["x-request-id"]).toBe(requestId);
    expect(answer.headers?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(answer.destroyed).toBeUndefined();
    // The log has the route and a closed name, never the canary.
    expect(JSON.stringify(log.mock.calls)).not.toContain(CANARY);
    const next = await call(failingWith(fail), "GET", "/api/v1/health");
    expect(next.status).toBe(200);
  });

  it.each(BODIES)(
    "a handler answering %s gets 500 internal, not a cut connection",
    async (_, body) => {
      quiet();
      const answer = await call(
        failingWith(async (_request, response) => sendJson(response, 200, body)),
        "GET",
        "/api/v1/ready",
      );
      expect(answer.status).toBe(500);
      expect(JSON.parse(answer.body ?? "")).toEqual(problem(500, "internal"));
    },
  );

  it("drops the headers and status line a failed handler set, keeps the security headers", async () => {
    quiet();
    const answer = await call(
      failingWith(async (_request, response) => {
        response.statusMessage = `db ${CANARY} down`;
        response.setHeader("x-debug", CANARY);
        response.setHeader("set-cookie", `s=${CANARY}`);
        response.setHeader("content-encoding", "gzip");
        response.setHeader("content-length", "3");
        response.setHeader("X-Frame-Options", CANARY);
        throw leaky();
      }),
      "GET",
      "/api/v1/ready",
    );
    expect([answer.status, answer.statusMessage]).toEqual([500, "Internal Server Error"]);
    expect(JSON.parse(answer.body ?? "")).toEqual(problem(500, "internal"));
    expect(JSON.stringify(answer.headers)).not.toContain(CANARY);
    expect(answer.headers).not.toHaveProperty("content-encoding");
    expect(answer.headers).not.toHaveProperty("content-length");
    expect(answer.headers?.["x-frame-options"]).toBe("DENY");
    expect(answer.headers?.connection).toBe("close");
  });

  it("a failure after a finished answer leaves it to complete", async () => {
    quiet();
    const answer = await call(
      failingWith(async (_request, response) => {
        sendJson(response, 200, { status: "ready" });
        throw leaky();
      }),
      "GET",
      "/api/v1/ready",
    );
    expect([answer.status, answer.body, answer.destroyed]).toEqual([
      200,
      '{"status":"ready"}',
      undefined,
    ]);
  });

  it("a failure after the head was sent writes nothing more and cuts the connection", async () => {
    quiet();
    const answer = await call(
      failingWith(async (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        throw leaky();
      }),
      "GET",
      "/api/v1/ready",
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
    expect(answer.destroyed).toBe(true);
  });
});

describe("errorName", () => {
  it.each([
    [new TypeError(CANARY), "TypeError"],
    [leaky(), "RangeError"],
    [Object.assign(new Error(CANARY), { name: `${CANARY} with spaces` }), "Error"],
    [Object.assign(new Error(CANARY), { name: 42 }), "Error"],
    [() => hostileName, "unreadable"],
    [revokedProxy, "unreadable"],
    [CANARY, "string"],
    [null, "null"],
    [undefined, "undefined"],
    [{ name: CANARY }, "object"],
    [Object.assign(new Error(CANARY), { name: "MadeUpCanary9z" }), "Error"],
    [new (class MadeUpCanaryError extends Error {})(CANARY), "Error"],
  ])("%#: a closed word, never the message", (error, name) => {
    // Hostile values come as factories, so the runner never formats them.
    const made = name === "unreadable" ? (error as () => unknown)() : error;
    expect(errorName(made)).toBe(name);
  });
});
