// Login over real HTTP against the fake OIDC provider in each of its four
// modes (S-1E-a, DAN-808; docs/PLAN.md, test table: "četiri načina lažnog
// OIDC-a"): success, refuse, expired and unavailable. The server runs the
// real pipeline, router and login routes; only the database ports are in
// memory. Accounts and values are invented (D-09: the fake provider runs
// only here, under NODE_ENV=test).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import type { OpenSessionInput } from "../database/index.ts";
import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../session/index.ts";

import { createFakeOidc, type FakeOidcMode } from "../../packages/test-fakes/oidc/index.ts";
import { createAuthRoutes } from "./auth.ts";
import { type AuthDeps, LOGIN_COOKIE_NAME } from "./auth-flow.ts";
import { createDatabases } from "./databases.ts";
import { sendHtmlProblem } from "./problem.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const EXPIRES = new Date("2030-01-01T12:00:00Z");

let app: Running | undefined;
let provider: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  if (provider) await new Promise<void>((done) => provider?.close(() => done()));
  app = undefined;
  provider = undefined;
});

type Stack = {
  origin: string;
  opened: OpenSessionInput[];
  closed: string[];
  logged: string[];
};

/**
 * The server first (its port names the callback), then the provider that
 * knows that callback. `delayUserinfo` holds the userinfo request back, so
 * the tokens of the expired mode are past their lifetime when they are used.
 */
async function stack(mode: FakeOidcMode, delayUserinfo = 0): Promise<Stack> {
  const opened: OpenSessionInput[] = [];
  const closed: string[] = [];
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const env: Record<string, string | undefined> = { NODE_ENV: "test" };
  const load = (): AuthDeps => {
    const config = loadAuthConfig(env);
    const slow: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (delayUserinfo > 0 && url.pathname === "/me") {
        await new Promise((done) => setTimeout(done, delayUserinfo));
      }
      return fetch(input, init);
    };
    return {
      config,
      oidc: createOidcClient(config, slow),
      openSession: async (input) => {
        opened.push(input);
        return { ok: true, expires: EXPIRES };
      },
      closeSession: async (token) => {
        closed.push(token);
        return true;
      },
      closeAllSessions: async () => undefined,
    };
  };
  app = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null }),
    databases: createDatabases(),
    routes: createAuthRoutes(env, load),
  });
  const origin = `http://127.0.0.1:${app.port}`;
  const callback = `${origin}/api/v1/auth/callback`;

  const server = createServer();
  provider = server;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = createFakeOidc({
    issuer,
    redirectUris: [callback],
    postLogoutRedirectUris: [`${origin}/`],
    backchannelLogoutUri: `${origin}/api/v1/auth/backchannel-logout`,
    mode,
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) =>
    fake.emit("request", req, res),
  );
  Object.assign(env, {
    DUCTUS_AUTH_PROVIDER: "fake-oidc",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "ductus-local",
    OIDC_CLIENT_SECRET: "ductus-local-only",
    OIDC_REDIRECT_URI: callback,
  });
  return { origin, opened, closed, logged };
}

/** A browser reduced to what the flow needs: one cookie jar and manual redirects. */
function browser() {
  const jar = new Map<string, string>();
  const get = async (
    url: string,
    init: { method?: string; form?: Record<string, string> } = {},
  ) => {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      if (/Max-Age=0/u.test(cookie)) jar.delete(name);
      else jar.set(name, pair.slice(at + 1));
    }
    return response;
  };
  return { get, jar };
}

function location(response: Response, base: string): string {
  const target = response.headers.get("location");
  if (target === null) throw new Error(`no redirect (${response.status})`);
  return new URL(target, base).href;
}

/** Login on the server, the account form on the provider, and back: the callback answer. */
async function signIn(origin: string, account = "demo-student") {
  const b = browser();
  const start = await b.get(`${origin}/api/v1/auth/login?returnTo=/radovi`);
  expect(start.status).toBe(303);
  expect(b.jar.has(LOGIN_COOKIE_NAME)).toBe(true);
  const authorize = location(start, origin);
  const interaction = location(await b.get(authorize), authorize);
  const resume = location(
    await b.get(`${interaction}/login`, { method: "POST", form: { account } }),
    interaction,
  );
  const back = location(await b.get(resume), resume);
  expect(back.startsWith(`${origin}/api/v1/auth/callback?`)).toBe(true);
  return { answer: await b.get(back), jar: b.jar };
}

/** The neutral page: the contract's HTML error, no cache, the attempt cleared, no session. */
async function expectPage(answer: Response, status: number, logged: string[]) {
  expect(answer.status).toBe(status);
  expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(answer.headers.get("x-request-id")).toEqual(expect.any(String));
  expect(answer.headers.get("location")).toBeNull();
  const cookies = answer.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
  const body = await answer.text();
  expect(body).toMatch(/^<!doctype html>\n<html lang="hr">/u);
  expect(body).toContain("Prijava nije dovršena");
  expect(body).toContain('href="/api/v1/auth/login"');
  // Logs carry a stage and a code, never a value from the provider or the request.
  expect(logged.join("\n")).not.toMatch(/demo-student|code=|state=/u);
  return cookies;
}

describe("login against the fake OIDC provider in each of its modes", () => {
  it("success: opens one session and sets its __Host- cookie for the token it hashed", async () => {
    const { origin, opened, closed } = await stack("success");
    const { answer, jar } = await signIn(origin);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`${origin}/radovi`);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const cookies = answer.headers.getSetCookie();
    expect(cookies).toContain(
      `${LOGIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(session).toBe(
      `${SESSION_COOKIE_NAME}=${jar.get(SESSION_COOKIE_NAME)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${EXPIRES.toUTCString()}`,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ subject: "demo-student", teacherEligible: false });
    expect(opened[0]?.tokenHash).toEqual(hashSessionToken(jar.get(SESSION_COOKIE_NAME) ?? ""));
    expect(closed).toEqual([]);
  });

  it("refuse: access_denied ends on the 400 page, with no session", async () => {
    const { origin, opened, logged } = await stack("refuse");
    const { answer, jar } = await signIn(origin);
    const cookies = await expectPage(answer, 400, logged);
    expect(cookies).toEqual([
      `${LOGIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    ]);
    expect(jar.has(LOGIN_COOKIE_NAME)).toBe(false);
    expect(opened).toEqual([]);
    expect(logged.some((line) => line.startsWith("login failed verify"))).toBe(true);
  });

  it("expired: tokens past their lifetime when used end on the 400 page, with no session", async () => {
    const { origin, opened, logged } = await stack("expired", 1_500);
    const { answer } = await signIn(origin, "demo-teacher");
    // Refused where the tokens are used (userinfo answers 401), not anywhere earlier.
    const cookies = await expectPage(answer, 400, logged);
    expect(cookies).toEqual([
      `${LOGIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    ]);
    // The userinfo challenge for an expired access token, not any other 400.
    expect(logged).toContain(
      "login failed verify WWWAuthenticateChallengeError:OAUTH_WWW_AUTHENTICATE_CHALLENGE",
    );
    expect(opened).toEqual([]);
  });

  it("unavailable: the login itself ends on the 503 page, with no attempt cookie", async () => {
    const { origin, opened, logged } = await stack("unavailable");
    const answer = await fetch(`${origin}/api/v1/auth/login`, { redirect: "manual" });
    const cookies = await expectPage(answer, 503, logged);
    expect(cookies).toEqual([]);
    expect(await (await fetch(`${origin}/api/v1/auth/login`)).text()).toContain(
      "Prijava preko AAI@EduHr trenutačno ne odgovara.",
    );
    expect(opened).toEqual([]);
  });
});

describe("the login routes over HTTP", () => {
  it("come from the contract, and answer another method 405 with Allow: GET", async () => {
    const { origin } = await stack("success");
    const ids = ROUTES.filter((r) => r.path.startsWith("/api/v1/auth/") && r.method === "GET");
    expect(ids.map((r) => r.id).sort()).toEqual(["auth.callback.get", "auth.login.get"]);
    for (const path of ["/api/v1/auth/login", "/api/v1/auth/callback"]) {
      const head = await fetch(`${origin}${path}`, { method: "HEAD" });
      expect(head.status, path).toBe(405);
      expect(head.headers.get("allow")).toBe("GET");
    }
  });

  it("build the callback URL from the configuration, never from Host", async () => {
    const { origin, opened } = await stack("success");
    const b = browser();
    const start = await b.get(`${origin}/api/v1/auth/login?returnTo=/radovi`);
    const authorize = location(start, origin);
    const interaction = location(await b.get(authorize), authorize);
    const resume = location(
      await b.get(`${interaction}/login`, { method: "POST", form: { account: "demo-student" } }),
      interaction,
    );
    const back = location(await b.get(resume), resume);
    // The callback arrives with a forged Host; the provider redeems the code
    // only for the configured redirect URI, and the browser goes back to the
    // configured origin.
    const answer = await fetch(back, {
      redirect: "manual",
      headers: {
        host: "attacker.invalid",
        cookie: [...b.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      },
    });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`${origin}/radovi`);
    expect(opened).toHaveLength(1);
  });

  it("a callback replayed after a login opens no second session", async () => {
    const { origin, opened } = await stack("success");
    const b = browser();
    const start = await b.get(`${origin}/api/v1/auth/login`);
    const authorize = location(start, origin);
    const interaction = location(await b.get(authorize), authorize);
    const resume = location(
      await b.get(`${interaction}/login`, { method: "POST", form: { account: "demo-student" } }),
      interaction,
    );
    const back = location(await b.get(resume), resume);
    expect((await b.get(back)).status).toBe(303);
    expect((await b.get(back)).status).toBe(400);
    expect(opened).toHaveLength(1);
  });

  it("expired, used at once: the same mode signs in, so only the lifetime refuses above", async () => {
    const { origin, opened } = await stack("expired");
    const { answer } = await signIn(origin, "demo-teacher");
    expect(answer.status).toBe(303);
    expect(opened).toHaveLength(1);
  });
});

describe("a login configuration that does not load", () => {
  // Ported from Ductus tests/unit/auth/routes.test.ts at 078c780 ("ends on
  // the neutral page, naming no variable"), over the real routes here.
  it.each([["production"], [undefined]])(
    "D-09: the fake provider with NODE_ENV %s ends on the 503 page, naming no variable",
    async (nodeEnv) => {
      const logged: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
      const env = {
        NODE_ENV: nodeEnv,
        DUCTUS_AUTH_PROVIDER: "fake-oidc",
        OIDC_ISSUER: "http://127.0.0.1:9400",
        OIDC_CLIENT_ID: "ductus-local",
        OIDC_CLIENT_SECRET: "ductus-local-only",
        OIDC_REDIRECT_URI: "http://127.0.0.1:4000/api/v1/auth/callback",
      };
      app = await startServer({
        host: "127.0.0.1",
        port: 0,
        layers: createLayers({ expectedOrigin: null }),
        databases: createDatabases(),
        routes: createAuthRoutes(env),
      });
      for (const path of ["/api/v1/auth/login", "/api/v1/auth/callback?code=x&state=y"]) {
        const answer = await fetch(`http://127.0.0.1:${app.port}${path}`, { redirect: "manual" });
        expect(answer.status, path).toBe(503);
        expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(answer.headers.getSetCookie()).toEqual([]);
        const body = await answer.text();
        expect(body).toContain("Prijava preko AAI@EduHr trenutačno ne odgovara.");
        expect(body).not.toMatch(/NODE_ENV|DUCTUS_AUTH_PROVIDER|OIDC_|fake/u);
      }
      expect(logged).toEqual([
        "login failed config AuthConfigError",
        "login failed config AuthConfigError",
      ]);
    },
  );
});

describe("sendHtmlProblem", () => {
  it("answers 500 internal for an error the contract does not give an HTML body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const login = ROUTES.find((r) => r.id === "auth.login.get");
    if (login === undefined) throw new Error("no auth.login.get");
    app = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: null }),
      databases: createDatabases(),
      routes: [
        {
          contract: login,
          handle: async (_request, response) => {
            response.setHeader("set-cookie", "planted=1");
            sendHtmlProblem(response, { status: 404, code: "not_found", key: "x" }, "<p>x</p>");
          },
        },
      ],
    });
    const answer = await fetch(`http://127.0.0.1:${app.port}/api/v1/auth/login`);
    expect(answer.status).toBe(500);
    expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(await answer.json()).toMatchObject({ code: "internal" });
  });

  it("drops a cookie the handler set and keeps only the ones it is given", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const login = ROUTES.find((r) => r.id === "auth.login.get");
    const spec = login?.errors.find((e) => e.status === 503);
    if (login === undefined || spec === undefined) throw new Error("no auth.login.get 503");
    app = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: null }),
      databases: createDatabases(),
      routes: [
        {
          contract: login,
          handle: async (_request, response) => {
            response.setHeader("set-cookie", "planted=1");
            response.setHeader("location", "https://elsewhere.invalid/");
            sendHtmlProblem(response, spec, "<p>x</p>", ["kept=; Max-Age=0"]);
          },
        },
      ],
    });
    const answer = await fetch(`http://127.0.0.1:${app.port}/api/v1/auth/login`, {
      redirect: "manual",
    });
    expect(answer.status).toBe(503);
    expect(answer.headers.getSetCookie()).toEqual(["kept=; Max-Age=0"]);
    expect(answer.headers.get("location")).toBeNull();
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await answer.text()).toBe("<p>x</p>");
  });
});
