// POST /api/v1/auth/logout over real HTTP (S-1D-d, DAN-829-1): the real
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
  readFileSync(new URL("../contracts/vectors/auth.logout.post.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const vector = (name: string) => vectors.find((v) => v.name === name)!;
const GOOD = vector("session-closed").request.headers;
const ORIGIN = GOOD.origin!;

let app: Running | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

async function start(fail: "config" | null = null) {
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
      closeSession: async (token) => {
        closed.push(token);
        return true;
      },
      closeAllSessions: () => Promise.reject(new Error("not used")),
    };
  };
  app = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createAuthRoutes({ NODE_ENV: "test" }, load),
  });
  const send = (method: string, headers: Record<string, string> = GOOD, body?: string) =>
    fetch(`http://127.0.0.1:${app!.port}/api/v1/auth/logout`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body }),
    });
  return { closed, send };
}

/** A Set-Cookie as its name and value and its attributes, in any order. */
function parsed(cookie: string) {
  const [pair = "", ...attributes] = cookie.split(";").map((part) => part.trim());
  return { pair, attributes: attributes.map((a) => a.toLowerCase()).sort() };
}

describe("logout answers POST alone", () => {
  it.each(["GET", "HEAD", "PUT"])(
    "N1: %s with a session cookie is 405, no one signed out",
    async (m) => {
      const { closed, send } = await start();
      const answer = await send(m);
      expect(answer.status).toBe(405);
      expect(answer.headers.get("allow")).toBe("POST");
      expect(answer.headers.getSetCookie()).toEqual([]);
      expect(closed).toEqual([]);
    },
  );

  it.each<[string, Record<string, string>]>([
    ["no Origin", { cookie: GOOD.cookie! }],
    ["Origin null", { ...GOOD, origin: "null" }],
    ["same-site", { ...GOOD, "sec-fetch-site": "same-site" }],
    ["two Origins", { ...GOOD, origin: `${ORIGIN}, ${ORIGIN}` }],
    ["a cross-site fetch", { ...GOOD, "sec-fetch-site": "cross-site" }],
  ])("N2: POST with %s is the HTML 403 and closes nothing", async (_n, headers) => {
    const { closed, send } = await start();
    const answer = await send("POST", headers);
    expect(answer.status).toBe(403);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("N5: Host and X-Forwarded-* do not reach the address", async () => {
    const { send } = await start();
    const answer = await send("POST", {
      ...GOOD,
      host: "napadac.test",
      "x-forwarded-host": "napadac.test",
      "x-forwarded-proto": "http",
    });
    expect(answer.headers.get("location")).toBe(`${ORIGIN}/`);
  });
});

describe("the vectors of auth.logout.post", () => {
  it("P2 session-closed: 303 home, the cookie cleared, this session closed", async () => {
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

  it("N3 forbidden: a cross-site POST is 403 and closes nothing", async () => {
    const v = vector("forbidden");
    const { closed, send } = await start();
    expect((await send("POST", v.request.headers)).status).toBe(v.response.status);
    expect(closed).toEqual([]);
  });

  it("N3 unavailable: settings that do not load give the 503 page, the cookie kept", async () => {
    const v = vector("unavailable");
    const { send } = await start("config");
    const answer = await send("POST", v.request.headers);
    expect(answer.status).toBe(v.response.status);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answer.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["Content-Length: 0", ""],
    ["a body it never reads", "a=1"],
  ])("P3: a POST with %s is the same 303", async (_n, body) => {
    const { closed, send } = await start();
    expect((await send("POST", GOOD, body)).status).toBe(303);
    expect(closed).toEqual(["izmisljeni-token-0001"]);
  });
});
