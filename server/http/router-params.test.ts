// DAN-857-1: a contract path with `{name}` segments. The router hands each
// value to the handler raw, as sent; the route decodes and checks it, a work
// id only through workIdFromPath (S-1H.1-c). Negative cases first.
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { ROUTES, type RouteContract, workIdFromPath } from "../contracts/index.ts";
import { createRouter, type Route } from "./router.ts";

const contract = (id: string): RouteContract => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const COMMENTS = contract("collaboration.comments.post");
const LIVE_GET = contract("live.document.get");
const LIVE_PUT = contract("live.document.put");

type Seen = { status?: number; headers: Record<string, string>; body?: string; params?: unknown };

/** A route that answers 200 and keeps the params it got. */
const recording = (routeContract: RouteContract, seen: Seen[]): Route => ({
  contract: routeContract,
  handle: async (_request, response, params) => {
    seen.push({ headers: {}, params });
    response.writeHead(200);
    response.end();
  },
});

async function call(routes: readonly Route[], method: string, url: string): Promise<Seen> {
  const seen: Seen[] = [];
  const answer: Seen = { headers: {} };
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
    writeHead(status: number, headers?: Record<string, string>) {
      answer.status = status;
      answer.headers = { ...Object.fromEntries(set), ...headers };
      this.headersSent = true;
    },
    end(body?: string) {
      if (body !== undefined) answer.body = body;
      this.writableEnded = true;
    },
    destroy: () => undefined,
  };
  const withSeen = routes.map((route) => recording(route.contract, seen));
  await createRouter(withSeen)(
    { method, url } as IncomingMessage,
    response as never as ServerResponse,
  );
  return { ...answer, params: seen[0]?.params };
}

const asRoutes = (...contracts: RouteContract[]): Route[] =>
  contracts.map((c) => ({ contract: c, handle: async () => undefined }));
const errorOf = (answer: Seen) => (JSON.parse(answer.body ?? "{}") as { error?: string }).error;

describe("createRouter with path parameters: refusals", () => {
  const routes = asRoutes(COMMENTS, LIVE_GET, LIVE_PUT);

  it.each([
    ["an empty segment", "/api/v1/comments/"],
    ["one segment too many", "/api/v1/comments/create/x"],
    ["one segment too few", "/api/v1/comments"],
    ["an empty value before the query", "/api/v1/comments/?action=create"],
    ["a dot segment as sent", "/api/v1/comments/."],
    ["two dots as sent", "/api/v1/comments/.."],
  ])("%s is 404 not_found and the handler is not called", async (_, url) => {
    const answer = await call(routes, "POST", url);
    expect([answer.status, errorOf(answer), answer.params]).toEqual([404, "not_found", undefined]);
  });

  it.each(["%", "%E0%A4%A", "%ZZ", "%C0%AF", "%ED%A0%80", "a%"])(
    "a malformed encoding %j reaches the route raw, never 500, and is no work id",
    async (value) => {
      const answer = await call(routes, "GET", `/api/v1/live/${value}`);
      expect([answer.status, answer.params]).toEqual([200, { documentId: value }]);
      expect(workIdFromPath(value)).toBeNull();
    },
  );

  it("another method on a template is 405 with the methods of that path", async () => {
    const answer = await call(routes, "POST", "/api/v1/live/izmisljeni-rad-0001");
    expect([answer.status, errorOf(answer), answer.headers.allow]).toEqual([
      405,
      "method_not_allowed",
      "GET, PUT",
    ]);
  });

  it("two templates of one shape on one method are a programming error", () => {
    const renamed = { ...COMMENTS, path: "/api/v1/comments/{other}" };
    expect(() => createRouter(asRoutes(COMMENTS, renamed))).toThrow(/overlapping routes/u);
  });
});

describe("createRouter with path parameters: values", () => {
  it("two paths that can match one request are a programming error, in either order", () => {
    const literal = { ...COMMENTS, id: "invented.literal", path: "/api/v1/comments/list" };
    const other = { ...LIVE_GET, id: "invented.other", path: "/api/v1/{area}/create" };
    for (const pair of [
      [literal, COMMENTS],
      [COMMENTS, literal],
      [other, COMMENTS],
    ]) {
      expect(() => createRouter(asRoutes(...pair))).toThrow(/overlapping routes/u);
    }
  });

  it("every contract path matches no other, and no template is a provider or HTML route", () => {
    expect(() =>
      createRouter(ROUTES.map((c) => ({ contract: c, handle: async () => undefined }))),
    ).not.toThrow();
    for (const route of ROUTES.filter((r) => r.path.includes("{"))) {
      // The origin layer finds these by the literal path only (mutation-request.ts).
      expect(route.access).not.toBe("identity_provider");
      expect(route.errors.some((e) => e.status === 403 && e.body === "html")).toBe(false);
    }
  });

  it("hands the value without the query", async () => {
    const answer = await call(asRoutes(COMMENTS), "POST", "/api/v1/comments/create?x=1");
    expect([answer.status, answer.params]).toEqual([200, { action: "create" }]);
  });

  it.each([
    ["CRLF", "%0D%0A", null],
    ["tab", "%09", null],
    ["NBSP", "%C2%A0", null],
    ["DEL", "%7F", null],
    ["an encoded slash", "a%2Fb", "a/b"],
    ["encoded dots", "%2E%2E", ".."],
    ["an encoded percent", "%2500", "%00"],
    ["a backslash", "%5C", "\\"],
    ["a Windows path", "C%3A%5Cx", "C:\\x"],
    ["__proto__", "__proto__", "__proto__"],
    ["toString", "toString", "toString"],
    ["constructor", "constructor", "constructor"],
    ["an emoji", "%F0%9F%93%9D", "📝"],
    ["a plus sign", "a+b", "a+b"],
  ])("%s reaches the route raw; workIdFromPath decodes it once", async (_, sent, workId) => {
    const answer = await call(asRoutes(LIVE_GET), "GET", `/api/v1/live/${sent}`);
    expect([answer.status, answer.params]).toEqual([200, { documentId: sent }]);
    expect(workIdFromPath(sent)).toBe(workId);
  });

  it("params has no prototype, only the contract's names, and is frozen", async () => {
    const answer = await call(asRoutes(COMMENTS), "POST", "/api/v1/comments/toString");
    const params = answer.params as Record<string, string>;
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.keys(params)).toEqual(["action"]);
    expect(Object.isFrozen(params)).toBe(true);
    expect("toString" in params).toBe(false);
  });

  it("a route without parameters gets an empty frozen object", async () => {
    const answer = await call(asRoutes(contract("platform.ready.get")), "GET", "/api/v1/ready");
    expect(answer.params).toEqual({});
    expect(Object.isFrozen(answer.params)).toBe(true);
  });
});
