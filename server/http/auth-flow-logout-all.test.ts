// Ported from Ductus tests/unit/auth/flow-logout-all.test.ts at 333e163
// (S-1D-c, DAN-828-1): sign out on every device, against the real
// openid-client and the in-process provider. Every value is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";
import { type AuthDeps, logoutAll } from "./auth-flow.ts";

import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../test-support/test-idp/index.ts";

const APP = "https://ductus.test";
const config = loadAuthConfig({
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${APP}/api/v1/auth/callback`,
});
const ENDPOINT = `${ISSUER}/session/end`;
const PROVIDER_LOGOUT = `${ENDPOINT}?post_logout_redirect_uri=${encodeURIComponent(`${APP}/`)}&client_id=${CLIENT_ID}`;
const TOKEN = "a".repeat(43);
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: APP };
const CLEARED = "__Host-ductus_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

let idp: ReturnType<typeof createTestIdp>;
let deps: AuthDeps & { closeAllSessions: ReturnType<typeof vi.fn> };
let errors: ReturnType<typeof vi.spyOn>;
let events: string[];

beforeEach(() => {
  idp = createTestIdp();
  idp.state.next = { endSessionEndpoint: ENDPOINT };
  events = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    events.push("provider");
    return idp.fetch(...args);
  }) as typeof fetch;
  deps = {
    config,
    oidc: createOidcClient(config, fetchImpl),
    openSession: vi.fn(),
    closeSession: vi.fn(async () => true),
    closeAllSessions: vi.fn(async () => {
      events.push("close_all");
    }),
  };
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function post(headers: Record<string, string> = SAME_ORIGIN, cookie: string | null = TOKEN) {
  return logoutAll(
    new Request(`${APP}/api/v1/auth/logout-all`, {
      method: "POST",
      headers:
        cookie === null ? headers : { cookie: `__Host-ductus_session=${cookie}`, ...headers },
    }),
    deps,
  );
}

describe("POST /api/v1/auth/logout-all", () => {
  it.each([
    ["a cross-site origin", { "sec-fetch-site": "cross-site", origin: "https://napadac.test" }],
    ["a foreign origin", { origin: "https://napadac.test" }],
    ["no Origin", { "sec-fetch-site": "same-origin" }],
    ["Origin null", { origin: "null" }],
    ["a same-site but not same-origin fetch", { "sec-fetch-site": "same-site", origin: APP }],
  ])("%s is refused before the database and the provider, the cookie untouched", async (_n, h) => {
    const response = await post(h);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(deps.closeAllSessions).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(errors).toHaveBeenCalledWith("login failed", "logout_all", "cross_origin");
  });

  it("when the database fails, answers 503, keeps the cookie and does not go to the provider", async () => {
    deps.closeAllSessions.mockRejectedValueOnce(
      Object.assign(new Error("down"), { code: "40P01" }),
    );
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(events).toEqual([]);
    expect(errors.mock.calls).toEqual([["login failed", "logout_all", "Error:40P01"]]);
    expect(await response.text()).not.toContain(TOKEN);
  });

  it.each([
    ["malformed", "nije-token"],
    ["unknown, closed, expired or idle", "b".repeat(43)],
    ["a DEL", `${"c".repeat(42)}\u007f`],
    ["an NBSP", `${"d".repeat(41)}\u00a0e`],
    ["a tab", `${"f".repeat(21)}\t${"g".repeat(21)}`],
  ])("a %s cookie goes to the database and the answer does not tell", async (_n, value) => {
    const withNothing = await post(SAME_ORIGIN, null);
    const response = await post(SAME_ORIGIN, value);
    // Without a cookie no query runs; with one, the database decides.
    expect(deps.closeAllSessions).toHaveBeenCalledExactlyOnceWith(value);
    expect(withNothing.headers.getSetCookie()).toEqual([CLEARED]);
    expect(response.status).toBe(withNothing.status);
    expect(response.headers.get("location")).toBe(withNothing.headers.get("location"));
    expect(response.headers.getSetCookie()).toEqual(withNothing.headers.getSetCookie());
  });

  it("closes every session of the account first, then clears the cookie and goes to the provider", async () => {
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(deps.closeAllSessions).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(events[0]).toBe("close_all");
    expect(events.slice(1).every((event) => event === "provider")).toBe(true);
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(JSON.stringify([...response.headers])).not.toContain(TOKEN);
  });

  it("when the provider fails, the local sign-out stands and / follows", async () => {
    idp.state.next = { endSessionEndpoint: ENDPOINT, down: true };
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP}/`);
    expect(deps.closeAllSessions).toHaveBeenCalledWith(TOKEN);
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(errors).toHaveBeenCalledWith("login failed", "end_session", expect.any(String));
  });
});
