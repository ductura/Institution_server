// STG-OIDC (Ductus#2055): the staging provider end to end in this process, as
// Render's TLS proxy would reach it (X-Forwarded-Proto: https), with the
// invented values of staging.test.ts.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { afterEach, expect, test, vi } from "vitest";

import { createFakeOidc, fakeOidcConfigFromEnv } from "./server.ts";

const APP = "https://ductura-staging.vercel.app";
const ISSUER = "https://ductura-fake-oidc-staging.onrender.com";
const CALLBACK = `${APP}/api/v1/auth/callback`;
// Invented test values of the required length, not secrets of any service.
const SECRET = "test-client-secret-0123456789abcdef";
const ENV = {
  NODE_ENV: "test",
  DUCTURA_DEPLOYMENT: "staging",
  APP_ORIGIN: APP,
  ISSUER,
  FAKE_OIDC_CLIENT_SECRET: SECRET,
  FAKE_OIDC_COOKIE_KEY: "test-cookie-key-0123456789abcdefghij",
};

let running: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((done) => server.close(() => done()));
});

/** The staging provider on a free loopback port; returns that local base. */
async function start(mode = "success"): Promise<string> {
  vi.stubEnv("DUCTURA_DEPLOYMENT", "staging");
  const { options } = fakeOidcConfigFromEnv({ ...ENV, FAKE_OIDC_MODE: mode });
  const provider = createFakeOidc(options);
  const server = createServer();
  running = server;
  server.on("request", (req: IncomingMessage, res: ServerResponse) =>
    provider.emit("request", req, res),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A browser behind the proxy: issuer addresses go to the local base, cookies kept. */
function browser(base: string) {
  const jar = new Map<string, string>();
  return async (url: string, init: { method?: string; form?: Record<string, string> } = {}) => {
    // Behind the proxy the provider builds https addresses of the host it
    // was reached by; the test reaches the same server over plain http.
    const local = url.startsWith(ISSUER)
      ? base + url.slice(ISSUER.length)
      : url.replace(/^https:\/\/127\.0\.0\.1:/u, "http://127.0.0.1:");
    const response = await fetch(new URL(local, base), {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        "x-forwarded-proto": "https",
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
}

const target = (response: Response): string => {
  const at = response.headers.get("location");
  if (at === null) throw new Error(`no redirect (${response.status})`);
  return at;
};

async function interaction(get: ReturnType<typeof browser>, redirectUri = CALLBACK) {
  const authorize = new URL("/auth", ISSUER);
  authorize.search = new URLSearchParams({
    client_id: "ductura-staging",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return get(authorize.href);
}

test("every answer names the staging deployment, the discovery the public issuer", async () => {
  const base = await start();
  const get = browser(base);
  const discovery = await get("/.well-known/openid-configuration");
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get("x-ductura-deployment")).toBe("staging");
  expect(await discovery.json()).toMatchObject({ issuer: ISSUER });
  for (const path of ["/favicon.ico", "/nema-te-stranice", "/interaction/nepoznato"]) {
    expect((await get(path)).headers.get("x-ductura-deployment"), path).toBe("staging");
  }
});

test("mode unavailable still names the deployment", async () => {
  const base = await start("unavailable");
  const response = await browser(base)("/.well-known/openid-configuration");
  expect(response.status).toBe(503);
  expect(response.headers.get("x-ductura-deployment")).toBe("staging");
});

test("a redirect outside APP_ORIGIN gets no login page", async () => {
  const base = await start();
  const response = await interaction(browser(base), "https://evil.example.test/callback");
  expect(response.status).toBe(400);
});

test("only the demo-* accounts sign in, and the browser goes back to APP_ORIGIN", async () => {
  const base = await start();
  const get = browser(base);
  const page = target(await interaction(get));
  const login = await get(page);
  expect(login.status).toBe(200);
  const html = await login.text();
  expect(html).toContain("Samo testno okruženje");
  expect(html).toContain('value="demo-student"');
  expect(html).not.toContain("Račun bilo koje ustanove");
  expect(html).not.toContain('name="domena"');

  for (const form of [
    { domena: "fpzg.hr", uloga: "student", korisnik: "iva" },
    { account: "sim:student:iva@fpzg.hr" },
    { account: "nepostojeci" },
  ]) {
    const refused = await get(`${page}/login`, { method: "POST", form });
    expect(refused.status, JSON.stringify(form)).toBe(400);
  }

  const resume = target(
    await get(`${page}/login`, { method: "POST", form: { account: "demo-student" } }),
  );
  const back = new URL(target(await get(resume)));
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get("code")).toEqual(expect.any(String));

  // The client secret is the one from the environment; the local one is refused.
  const tokenWith = (secret: string) =>
    get("/token", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        redirect_uri: CALLBACK,
        code_verifier: "v".repeat(43),
        client_id: "ductura-staging",
        client_secret: secret,
      },
    });
  expect((await tokenWith("ductus-local-only")).status).toBe(401);
  const tokens = await tokenWith(SECRET);
  expect(tokens.status).toBe(200);
  const { id_token: idToken } = (await tokens.json()) as { id_token: string };
  const [head = "", body = ""] = idToken.split(".");
  // Signed with the key this process made, never the library's published one.
  const { kid } = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { kid: string };
  const { keys } = (await (await get("/jwks")).json()) as { keys: { kid: string; n: string }[] };
  expect(keys.map((key) => key.kid)).toEqual([kid]);
  expect(kid).toMatch(/^[0-9a-f-]{36}$/u);
  const published = readFileSync(
    createRequire(import.meta.url)
      .resolve("oidc-provider")
      .replace(/lib[\\/]index\.js$/u, "lib/consts/dev_keystore.js"),
    "utf8",
  );
  for (const key of keys) {
    expect(key).not.toHaveProperty("d");
    expect(published).not.toContain(key.n.slice(0, 40));
  }
  expect(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))).toMatchObject({
    iss: ISSUER,
    aud: "ductura-staging",
    sub: "demo-student",
  });
});
