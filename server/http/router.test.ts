import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createRouter, type Route } from "./router.ts";

type Answer = {
  status?: number;
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
  const response = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      answer.headers = headers;
      this.headersSent = true;
    },
    end(body: string) {
      answer.body = body;
    },
    destroy() {
      answer.destroyed = true;
    },
  };
  const request = { method, url } as IncomingMessage;
  return router(request, response as unknown as ServerResponse).then(() => answer);
}

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
    ["an unknown path", "GET", "/api/v1/nope", 404, { error: "not_found" }],
    ["a trailing slash", "GET", "/api/v1/health/", 404, { error: "not_found" }],
    ["an encoded path", "GET", "/api/v1/%68ealth", 404, { error: "not_found" }],
    ["another method", "DELETE", "/api/v1/health", 405, { error: "method_not_allowed" }],
    ["HEAD", "HEAD", "/api/v1/health", 405, { error: "method_not_allowed" }],
  ])("refuses %s in the contract format", async (_, method, url, status, body) => {
    const answer = await call(router, method, url);
    expect([answer.status, JSON.parse(answer.body ?? "")]).toEqual([status, body]);
    if (status === 405) expect(answer.headers?.allow).toBe("GET");
  });

  it("answers 500 when a handler throws, without the error message", async () => {
    const answer = await call(router, "GET", "/api/v1/ready");
    expect([answer.status, JSON.parse(answer.body ?? "")]).toEqual([500, { error: "internal" }]);
    expect(answer.body).not.toContain("invented-canary");
  });

  it("refuses two routes on one method and path", () => {
    expect(() => createRouter([HEALTH_ROUTE, HEALTH_ROUTE])).toThrow(/duplicate route/u);
  });
});
