// POST /api/v1/auth/logout-all over real HTTP (S-1D-c, DAN-828-1): the real
// pipeline, router and route; the database ports and the provider are in
// memory. A GET never signs anyone out, and the route meets its vectors.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAuthConfig } from "../external/srce-auth/index.ts";
import { createAuthRoutes } from "./auth.ts";
import type { AuthDeps } from "./auth-flow.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string> };
  response: { status: number; headers?: { location?: string; "set-cookie"?: string[] } };
};
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/auth.logout-all.post.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const vector = (name: string) => vectors.find((v) => v.name === name)!;
const GOOD = vector("session-closed").request.headers;
const ORIGIN = GOOD.origin!;
const PATH = "/api/v1/auth/logout-all";

let app: Running | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

/** The server with in-memory ports; `fail` makes closing all sessions throw. */
async function start(fail: "database" | "config" | null = null) {
  const closed: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const load = (): AuthDeps => {
    if (fail === "config") throw new Error("no configuration");
    return {
      config: loadAuthConfig({
        NODE_ENV: "test",
        DUCTUS_AUTH_PROVIDER: "fake-oidc",
        OIDC_ISSUER: "http://127.0.0.1:9400",
        OIDC_CLIENT_ID: "ductus-local",
        OIDC_CLIENT_SECRET: "ductus-local-only",
        OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/callback`,
      }),
      oidc: {
        authorizationUrl: () => Promise.reject(new Error("not used")),
        verify: () => Promise.reject(new Error("not used")),
        endSessionUrl: async () => null,
      },
      openSession: () => Promise.reject(new Error("not used")),
      closeSession: () => Promise.reject(new Error("not used")),
      closeAllSessions: async (token) => {
        if (fail === "database") throw Object.assign(new Error("down"), { code: "40P01" });
        closed.push(token);
      },
    };
  };
  app = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createAuthRoutes({ NODE_ENV: "test" }, load),
  });
  const send = (
    method: string,
    headers: Record<string, string> = GOOD,
    body?: string,
    query = "",
  ) =>
    fetch(`http://127.0.0.1:${app!.port}${PATH}${query}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body }),
    });
  return { closed, send };
}

/** The vector `forbidden`: the neutral HTML page, no cookie, the connection closed. */
async function expectHtml403(answer: Response) {
  expect(answer.status).toBe(403);
  expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(answer.headers.get("connection")).toBe("close");
  expect(answer.headers.get("location")).toBeNull();
  expect(answer.headers.getSetCookie()).toEqual([]);
  expect(await answer.text()).toMatch(/^<!doctype html>\n<html lang="hr">/u);
}

/** A Set-Cookie as its name and value and its attributes, in any order. */
function parsed(cookie: string) {
  const [pair = "", ...attributes] = cookie.split(";").map((part) => part.trim());
  return { pair, attributes: attributes.map((a) => a.toLowerCase()).sort() };
}

describe("logout-all answers POST alone", () => {
  it.each(["GET", "HEAD", "PUT"])(
    "%s with a session cookie is 405 and signs no one out",
    async (m) => {
      const { closed, send } = await start();
      const answer = await send(m);
      expect(answer.status).toBe(405);
      expect(answer.headers.get("allow")).toBe("POST");
      expect(answer.headers.getSetCookie()).toEqual([]);
      expect(closed).toEqual([]);
    },
  );

  it.each<[string, Record<string, string>, string?]>([
    ["no Origin", { cookie: GOOD.cookie! }],
    ["Origin null", { ...GOOD, origin: "null" }],
    ["same-site", { ...GOOD, "sec-fetch-site": "same-site" }],
    ["two Origins", { ...GOOD, origin: `${ORIGIN}, ${ORIGIN}` }],
    ["a cross-site fetch", { ...GOOD, "sec-fetch-site": "cross-site" }],
    ["a query on the path", { ...GOOD, origin: "https://drugo.example.invalid" }, "?a=1"],
  ])("POST with %s is refused by the pipeline with the HTML page", async (_n, headers, query) => {
    const { closed, send } = await start();
    await expectHtml403(await send("POST", headers, undefined, query ?? ""));
    expect(closed).toEqual([]);
  });
});

describe("the vectors of auth.logout-all.post", () => {
  it("session-closed: 303 home, the session cookie cleared, every session closed", async () => {
    const v = vector("session-closed");
    const { closed, send } = await start();
    const answer = await send("POST", v.request.headers);
    expect(answer.status).toBe(v.response.status);
    expect(answer.headers.get("location")).toBe(
      new URL(v.response.headers!.location!, ORIGIN).href,
    );
    expect(answer.headers.getSetCookie().map(parsed)).toEqual(
      v.response.headers!["set-cookie"]!.map(parsed),
    );
    expect(closed).toEqual(["izmisljeni-token-0001"]);
  });

  it("forbidden: a cross-site POST is 403 and closes nothing", async () => {
    const v = vector("forbidden");
    const { closed, send } = await start();
    const answer = await send("POST", v.request.headers);
    // Step 7 answers before the route, with the contract's HTML error (QA on #155).
    expect(answer.status).toBe(v.response.status);
    await expectHtml403(answer);
    expect(closed).toEqual([]);
  });

  it.each(["database", "config"] as const)(
    "unavailable (%s): 503 page, the cookie kept",
    async (fail) => {
      const v = vector("unavailable");
      const { send } = await start(fail);
      const answer = await send("POST", v.request.headers);
      expect(answer.status).toBe(v.response.status);
      expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(answer.headers.get("location")).toBeNull();
      expect(answer.headers.getSetCookie()).toEqual([]);
    },
  );

  it.each([
    ["Content-Length: 0", ""],
    ["a body it never reads", "a=1"],
  ])("a POST with %s is the same 303", async (_n, body) => {
    const { closed, send } = await start();
    const answer = await send("POST", GOOD, body);
    expect(answer.status).toBe(303);
    expect(closed).toEqual(["izmisljeni-token-0001"]);
  });
});
