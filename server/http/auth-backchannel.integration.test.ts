// OIDC back-channel logout over real HTTP (S-1D-d, DAN-829-3): the real
// pipeline with an expected origin set, the real router and createAuthRoutes,
// and the real logout verifier against the in-process test provider (D-09:
// only here, under NODE_ENV=test). Only the database port is in memory; it
// keeps the seen `jti` as identity.backchannel_logout does (ZD409 is
// `replayed`), whose SQL is proven by db/main/tests/109-backchannel-logout.sql.
// Every account and value is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackchannelLogoutInput } from "../database/index.ts";
import { accountIssuer, BACKCHANNEL_LOGOUT_EVENT } from "../external/srce-auth/index.ts";
import type { BackchannelDeps } from "../session/index.ts";

import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../test-support/test-idp/index.ts";
import { createAuthRoutes, loadBackchannelDeps } from "./auth.ts";
import type { AuthDeps } from "./auth-flow.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const APP = "https://ductus.invalid";
const SUB = "sub-demo-bc-829";
const SID = "sid-demo-bc-829";
const ENV = {
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${APP}/api/v1/auth/callback`,
};

let app: Running | undefined;
let calls: BackchannelLogoutInput[];
let logged: string[];
let jtiCounter = 0;
const idp = createTestIdp();

beforeEach(() => {
  calls = [];
  logged = [];
  idp.state.next = {};
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

/** The real composer; only the provider fetch and the database port are replaced. */
function backchannelDeps(): BackchannelDeps {
  const seen = new Set<string>();
  return loadBackchannelDeps(ENV, {
    fetch: idp.fetch,
    backchannelLogout: async (input) => {
      calls.push(input);
      if (seen.has(input.jti)) return { ok: false, reason: "replayed" };
      seen.add(input.jti);
      return { ok: true, closed: 1 };
    },
  });
}

async function start(
  load?: () => BackchannelDeps,
  env: Record<string, string> = ENV,
): Promise<string> {
  const composed = load ?? (env === ENV ? backchannelDeps : undefined);
  const unused = (): AuthDeps => {
    throw new Error("login deps are not used here");
  };
  app = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: APP }),
    databases: createDatabases(),
    routes: createAuthRoutes(env, unused, composed),
  });
  return `http://127.0.0.1:${app.port}`;
}

function token(): { token: string; jti: string } {
  const jti = `jti-demo-829-${++jtiCounter}`;
  const claims = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    jti,
    sub: SUB,
    sid: SID,
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
  };
  return { token: idp.logoutToken(claims), jti };
}

/** As the provider posts it: a form, no cookie and no Origin. */
async function post(origin: string, body: string, type = "application/x-www-form-urlencoded") {
  return fetch(`${origin}/api/v1/auth/backchannel-logout`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

const form = (value: string) => new URLSearchParams({ logout_token: value }).toString();

async function expectRefused(response: Response, status: 400 | 503): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
}

describe("POST /api/v1/auth/backchannel-logout", () => {
  it("N1: refuses a token the provider did not sign, closes nothing and logs a code", async () => {
    const origin = await start();
    idp.state.next = { signing: "foreign-key" };
    const { token: forged, jti } = token();
    await expectRefused(await post(origin, form(forged)), 400);
    expect(calls).toEqual([]);
    expect(logged.some((line) => line.startsWith("backchannel logout failed verify"))).toBe(true);
    for (const secret of [forged, forged.split(".")[2]!, SUB, SID, jti])
      expect(logged.join("\n")).not.toContain(secret);
  });

  it("N2: refuses the same valid token a second time and logs it without the token", async () => {
    const origin = await start();
    const { token: valid, jti } = token();
    expect((await post(origin, form(valid))).status).toBe(200);
    await expectRefused(await post(origin, form(valid)), 400);
    expect(calls.map((call) => call.jti)).toEqual([jti, jti]);
    expect(logged).toEqual(["backchannel logout failed close replayed"]);
  });

  it("N3: refuses a malformed request, or a body one byte over 16 KiB, before the verifier", async () => {
    const origin = await start();
    const { token: valid } = token();
    const twice = `${form(valid)}&${form(valid)}`;
    for (const [body, type] of [
      ["", undefined],
      ["other=1", undefined],
      [twice, undefined],
      [JSON.stringify({ logout_token: valid }), "application/json"],
      [`logout_token=${"a".repeat(16 * 1024 + 1 - "logout_token=".length)}`, undefined],
    ] as const) {
      await expectRefused(await post(origin, body, type), 400);
    }
    expect(calls).toEqual([]);
    expect(logged.join("\n")).not.toContain(valid);
  });

  it("N5: only POST on the provider's exact path skips the origin check", async () => {
    const origin = await start();
    const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: "POST" });
    expect(logout.status).toBe(403);
    for (const [method, path] of [
      ["PUT", "/api/v1/auth/backchannel-logout"],
      ["POST", "/api/v1/auth/backchannel-logout/"],
      ["POST", "/api/v1/auth//backchannel-logout"],
      ["POST", "/api/v1/evidence/open"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "origin_missing" });
    }
    // The query is not part of the path, for the router as for the exemption.
    const query = await fetch(`${origin}/api/v1/auth/backchannel-logout?x=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(token().token),
    });
    expect(query.status).toBe(200);
  });

  it("P1: closes what a valid token names, without Origin or cookie, and answers 200", async () => {
    const origin = await start();
    const { token: valid, jti } = token();
    const response = await post(origin, form(valid));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(calls).toEqual([
      { issuer: accountIssuer(new URL(ISSUER)), subject: SUB, sid: SID, jti },
    ]);
    expect(logged).toEqual([]);
  });

  it("P2: a login setup that does not load answers 503 and names no variable", async () => {
    // The default composer: OIDC_ISSUER is missing, so the configuration
    // throws before any provider or database is reached.
    const env = Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== "OIDC_ISSUER"));
    const origin = await start(undefined, env);
    await expectRefused(await post(origin, form(token().token)), 503);
    expect(logged).toEqual([expect.stringMatching(/^backchannel logout failed config \w+$/u)]);
    expect(logged.join("\n")).not.toMatch(/OIDC_|DUCTUS_/u);
  });

  it("P3: any other method is 405 and closes nothing", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/api/v1/auth/backchannel-logout`);
    expect(response.status).toBe(405);
    expect(calls).toEqual([]);
  });
});
