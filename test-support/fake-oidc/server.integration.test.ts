// The fake provider end to end in this process: one sign-in per mode, as an
// app would do it (code flow with PKCE), plus the D-09 refusal to start.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { DEMO_HOME_ORG } from "./accounts.ts";
import type { FakeOidcMode } from "./modes.ts";
import { createFakeOidc, type FakeOidcOptions } from "./server.ts";

const REDIRECT = "http://localhost:3000/api/auth/callback";
const BASIC = `Basic ${Buffer.from("ductus-local:ductus-local-only").toString("base64")}`;

let running: Server | undefined;
afterEach(async () => {
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((done) => server.close(() => done()));
});

function options(mode: FakeOidcMode, issuer: string): FakeOidcOptions {
  return {
    issuer,
    redirectUris: [REDIRECT],
    postLogoutRedirectUris: ["http://localhost:3000/"],
    backchannelLogoutUri: "http://localhost:3000/api/auth/backchannel-logout",
    mode,
  };
}

// The issuer names the port, so the port is taken first and the server built on it.
async function start(mode: FakeOidcMode): Promise<string> {
  const probe = createFakeOidc(options(mode, "http://localhost:1"));
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  const issuer = `http://localhost:${port}`;
  running = createFakeOidc(options(mode, issuer));
  const server = running;
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return issuer;
}

/** A browser reduced to what the flow needs: cookies and manual redirects. */
function browser() {
  const jar = new Map<string, string>();
  return async (url: string, init: { method?: string; form?: Record<string, string> } = {}) => {
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
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
}

function location(response: Response, base: string): string {
  const target = response.headers.get("location");
  if (target === null) throw new Error(`no redirect (${response.status})`);
  return new URL(target, base).href;
}

/** Signs `account` in and returns where the provider sent the browser back. */
async function signIn(issuer: string, account: string, verifier: string): Promise<URL> {
  const get = browser();
  const authorize = new URL("/auth", issuer);
  authorize.search = new URLSearchParams({
    client_id: "ductus-local",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const interaction = location(await get(authorize.href), issuer);
  const page = await get(interaction);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Ovo nije AAI@EduHr.");
  const resume = location(await get(`${interaction}/login`, { method: "POST", form: { account } }), issuer);
  return new URL(location(await get(resume), issuer));
}

async function token(issuer: string, code: string, verifier: string) {
  const response = await fetch(new URL("/token", issuer), {
    method: "POST",
    headers: { authorization: BASIC, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id_token: string; access_token: string };
}

function payload(jwt: string): Record<string, unknown> {
  const [, body = ""] = jwt.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

const userinfo = (issuer: string, accessToken: string) =>
  fetch(new URL("/me", issuer), { headers: { authorization: `Bearer ${accessToken}` } });

describe("modes", () => {
  test("success: code, tokens and the AAI@EduHr shaped claims of an invented account", async () => {
    const issuer = await start("success");
    const verifier = randomBytes(32).toString("base64url");
    const back = await signIn(issuer, "demo-student", verifier);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("state-1");
    const code = back.searchParams.get("code");
    expect(code).toEqual(expect.any(String));

    const tokens = await token(issuer, code ?? "", verifier);
    const id = payload(tokens.id_token);
    expect(id).toMatchObject({ iss: issuer, aud: "ductus-local", sub: "demo-student", nonce: "nonce-1" });
    const info = await userinfo(issuer, tokens.access_token);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      sub: "demo-student",
      hrEduPersonUniqueID: [`demo-student@${DEMO_HOME_ORG}`],
      hrEduPersonHomeOrg: [DEMO_HOME_ORG],
      hrEduPersonAffiliation: ["student"],
    });
  });

  test("success: a wrong PKCE verifier gets no tokens", async () => {
    const issuer = await start("success");
    const back = await signIn(issuer, "demo-student", randomBytes(32).toString("base64url"));
    const response = await fetch(new URL("/token", issuer), {
      method: "POST",
      headers: { authorization: BASIC, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: randomBytes(32).toString("base64url"),
      }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("refuse: the browser comes back with access_denied and no code", async () => {
    const issuer = await start("refuse");
    const back = await signIn(issuer, "demo-student", randomBytes(32).toString("base64url"));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.has("code")).toBe(false);
  });

  test("expired: tokens live one second, then the provider no longer accepts them", async () => {
    const issuer = await start("expired");
    const verifier = randomBytes(32).toString("base64url");
    const back = await signIn(issuer, "demo-teacher", verifier);
    const tokens = await token(issuer, back.searchParams.get("code") ?? "", verifier);
    const id = payload(tokens.id_token);
    expect(Number(id.exp) - Number(id.iat)).toBe(1);
    await delay(1_100);
    const info = await userinfo(issuer, tokens.access_token);
    expect(info.status).toBe(401);
    expect(info.headers.get("www-authenticate")).toMatch(/invalid_token/);
  });

  test("unavailable: discovery and authorization answer 503", async () => {
    const issuer = await start("unavailable");
    for (const path of ["/.well-known/openid-configuration", "/auth?client_id=ductus-local"]) {
      const response = await fetch(new URL(path, issuer), { redirect: "manual" });
      expect(response.status, path).toBe(503);
    }
  });

  test("an unknown account is refused at the login form", async () => {
    const issuer = await start("success");
    const get = browser();
    const authorize = `${issuer}/auth?client_id=ductus-local&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`;
    const interaction = location(await get(authorize), issuer);
    const response = await get(`${interaction}/login`, { method: "POST", form: { account: "constructor" } });
    expect(response.status).toBe(400);
  });
});

// D-09: the fake provider never starts with a production configuration.
describe("production refuses the fake provider", () => {
  test("createFakeOidc throws with NODE_ENV=production", () => {
    expect(() => createFakeOidc(options("success", "http://localhost:8080"), { NODE_ENV: "production" })).toThrow(/fake OIDC/);
  });

  const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
  const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

  function run(env: Record<string, string>) {
    const child = spawn(TSX, [SERVER], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    return { child, exited, output: () => output };
  }

  test("starting the server with NODE_ENV=production exits with an error before it listens", async () => {
    const { exited, output } = run({ NODE_ENV: "production", PORT: "0" });
    const code = await exited;
    expect(code).not.toBe(0);
    expect(output()).toMatch(/fake OIDC runs only locally and in CI/);
    expect(output()).not.toMatch(/demo prijava/);
  });

  test("the same start with NODE_ENV=test listens (the refusal above is the guard, not a broken start)", async () => {
    const { child, exited, output } = run({ NODE_ENV: "test", PORT: "0" });
    try {
      for (let i = 0; i < 100 && !output().includes("demo prijava"); i++) await delay(100);
      expect(output()).toMatch(/fake OIDC \(demo prijava, success\)/);
    } finally {
      child.kill();
      await exited;
    }
  });
});
