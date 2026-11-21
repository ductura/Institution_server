// SRV-1401 (DAN-296, plan M1.6) on a real node:http server through
// startServer: the enforced headers on success and on failure, no HSTS in
// local mode, no route's own CSP, and idle expiry with 401
// session_idle_expired while an active session is extended.
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { ROUTES, type RouteContract } from "../../contracts/index.ts";
import { createIdleTracker } from "../../identity/index.ts";
import { SESSION_COOKIE_NAME } from "../../session/index.ts";
import {
  createDatabases,
  createLayers,
  type Route,
  type Running,
  sendProblem,
  startServer,
} from "../index.ts";

import {
  CONTENT_SECURITY_POLICY,
  PERMISSIONS_POLICY,
  STRICT_TRANSPORT_SECURITY,
  type SecurityMode,
} from "./index.ts";

const MINUTE = 60_000;
// Invented session tokens in the cookie's format (43 base64url characters).
const TOKEN_IDLE = "i".repeat(43);
const TOKEN_ACTIVE = "k".repeat(43);

function contract(id: string): RouteContract {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}

const ME = contract("profile.me.get");
const LOCALE = contract("profile.interface-locale.get");
const LOGOUT = contract("auth.logout.post");
const HEALTH = contract("platform.health.get");

/** Routes over real contracts with invented answers; LOCALE always refuses. */
function routes(): Route[] {
  const ok = (c: RouteContract, csp?: "set" | "head"): Route => ({
    contract: c,
    handle: async (_request, response) => {
      // A route that tries to set its own policies (acceptance 4).
      if (csp === "set") {
        response.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline'");
        response.setHeader("Strict-Transport-Security", "max-age=1");
        response.setHeader("Permissions-Policy", "camera=*");
      }
      const head: Record<string, string> =
        csp === "head"
          ? {
              "content-security-policy": "script-src 'unsafe-inline'",
              "PERMISSIONS-POLICY": "microphone=*",
            }
          : {};
      response.writeHead(200, { "Content-Type": "application/json", ...head });
      response.end("{}");
    },
  });
  return [
    ok(ME, "set"),
    ok(HEALTH, "head"),
    ok(LOGOUT),
    { contract: LOCALE, handle: async (_q, res) => sendProblem(res, 401, "unauthorized") },
  ];
}

const servers: Running[] = [];
afterAll(async () => {
  for (const server of servers) server.closeAllConnections();
});

async function serve(options: { security?: SecurityMode; now?: () => number } = {}) {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "http://localhost" }),
    databases: createDatabases(),
    routes: routes(),
    ...(options.security === undefined ? {} : { security: options.security }),
    ...(options.now === undefined ? {} : { idle: createIdleTracker({ now: options.now }) }),
  });
  servers.push(server);
  return server;
}

type Answer = { status: number; headers: IncomingHttpHeaders; raw: string[]; body: string };

function call(
  server: Running,
  path: string,
  options: { method?: string; token?: string; origin?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { connection: "close" };
  if (options.token !== undefined) headers.cookie = `${SESSION_COOKIE_NAME}=${options.token}`;
  if (options.origin !== undefined) {
    headers.origin = options.origin;
    headers["sec-fetch-site"] = "same-origin";
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, path, method: options.method ?? "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: res.rawHeaders, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const count = (raw: string[], key: string) =>
  raw.filter((name, i) => i % 2 === 0 && name.toLowerCase() === key.toLowerCase()).length;

function expectPolicies(answer: Answer, hsts: boolean) {
  expect(answer.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  expect(answer.headers["content-security-policy"]).not.toMatch(/unsafe-inline|unsafe-eval/u);
  expect(answer.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
  expect(PERMISSIONS_POLICY).toMatch(/(^|, )camera=\(\)/u);
  expect(PERMISSIONS_POLICY).toMatch(/(^|, )microphone=\(\)/u);
  expect(PERMISSIONS_POLICY).toMatch(/(^|, )geolocation=\(\)/u);
  expect(count(answer.raw, "content-security-policy")).toBe(1);
  expect(count(answer.raw, "permissions-policy")).toBe(1);
  if (hsts) {
    expect(answer.headers["strict-transport-security"]).toBe(STRICT_TRANSPORT_SECURITY);
    expect(count(answer.raw, "strict-transport-security")).toBe(1);
  } else {
    expect(answer.headers["strict-transport-security"]).toBeUndefined();
  }
}

describe("enforced security headers (SRV-1401, M1.6)", () => {
  // Success, a route's own refusal, the router's 404 and the pipeline's 403.
  const CASES = [
    { name: "200 of a route", path: "/api/v1/me", status: 200 },
    { name: "200 of a route that sets headers in writeHead", path: "/api/v1/health", status: 200 },
    { name: "401 of a route", path: "/api/v1/profile/interface-locale", status: 401 },
    { name: "404 of the router", path: "/api/v1/no-such-route", status: 404 },
    { name: "403 of the origin check", path: "/api/v1/auth/logout", status: 403, method: "POST" },
  ] as const;

  for (const mode of [{ local: false }, { local: true }] as const) {
    for (const c of CASES) {
      it(`${mode.local ? "local" : "production"}: ${c.name}`, async () => {
        const server = await serve({ security: mode });
        const answer = await call(server, c.path, {
          token: TOKEN_ACTIVE,
          ...("method" in c ? { method: c.method } : {}),
        });
        expect(answer.status).toBe(c.status);
        expectPolicies(answer, !mode.local);
      });
    }
  }

  it("without a mode, HSTS is on", async () => {
    const server = await serve();
    expectPolicies(await call(server, "/api/v1/me", { token: TOKEN_ACTIVE }), true);
  });

  it("a route's own CSP, Permissions-Policy and HSTS never reach the client", async () => {
    const server = await serve({ security: { local: true } });
    const set = await call(server, "/api/v1/me", { token: TOKEN_ACTIVE });
    expect(set.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(set.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
    expect(set.headers["strict-transport-security"]).toBeUndefined();
    const head = await call(server, "/api/v1/health");
    expect(head.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(head.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
    expect(head.headers["content-type"]).toBe("application/json");
  });
});

describe("idle expiry (SRV-1401, M1.6)", () => {
  it("a session idle past 30 minutes gets 401 session_idle_expired; an active one is extended", async () => {
    let at = 0;
    const server = await serve({ now: () => at });
    expect((await call(server, "/api/v1/me", { token: TOKEN_IDLE })).status).toBe(200);
    expect((await call(server, "/api/v1/me", { token: TOKEN_ACTIVE })).status).toBe(200);

    for (let i = 0; i < 3; i++) {
      at += 20 * MINUTE;
      expect((await call(server, "/api/v1/me", { token: TOKEN_ACTIVE })).status).toBe(200);
    }

    const idle = await call(server, "/api/v1/me", { token: TOKEN_IDLE });
    expect(idle.status).toBe(401);
    expect(JSON.parse(idle.body)).toMatchObject({
      code: "session_idle_expired",
      error: "session_idle_expired",
      messageKey: "errors.sessionIdleExpired",
      status: 401,
    });
    expectPolicies(idle, true);
    // Still refused on every route that needs a session, and it stays so.
    expect((await call(server, "/api/v1/me", { token: TOKEN_IDLE })).status).toBe(401);
    expect(
      JSON.parse(
        (await call(server, "/api/v1/profile/interface-locale", { token: TOKEN_IDLE })).body,
      ),
    ).toMatchObject({ code: "session_idle_expired" });
  });

  it("routes without a session and sign-out are not idle-checked", async () => {
    let at = 0;
    const server = await serve({ now: () => at });
    expect((await call(server, "/api/v1/me", { token: TOKEN_IDLE })).status).toBe(200);
    at += 31 * MINUTE;
    expect((await call(server, "/api/v1/health", { token: TOKEN_IDLE })).status).toBe(200);
    const logout = await call(server, "/api/v1/auth/logout", {
      method: "POST",
      token: TOKEN_IDLE,
      origin: "http://localhost",
    });
    expect(logout.status).toBe(200);
    expect((await call(server, "/api/v1/me", { token: TOKEN_IDLE })).status).toBe(401);
  });

  it("a refused request does not extend the session", async () => {
    let at = 0;
    const server = await serve({ now: () => at });
    expect((await call(server, "/api/v1/me", { token: TOKEN_IDLE })).status).toBe(200);
    at += 25 * MINUTE;
    expect(
      (await call(server, "/api/v1/profile/interface-locale", { token: TOKEN_IDLE })).status,
    ).toBe(401);
    at += 5 * MINUTE;
    const answer = await call(server, "/api/v1/me", { token: TOKEN_IDLE });
    expect(JSON.parse(answer.body)).toMatchObject({ code: "session_idle_expired" });
  });
});
