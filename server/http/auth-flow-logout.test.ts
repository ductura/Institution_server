// Ported from Ductus tests/unit/auth/flow-logout.test.ts at 393b8e0 (S-1D-d,
// DAN-829-1): sign out of this session, against the real openid-client and
// the in-process provider. Every value is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";
import { type AuthDeps, logout } from "./auth-flow.ts";

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
const TOKEN = "t".repeat(43);
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: APP };
const CLEARED = "__Host-ductus_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

let idp: ReturnType<typeof createTestIdp>;
let deps: AuthDeps & { closeSession: ReturnType<typeof vi.fn> };
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
    closeSession: vi.fn(async () => {
      events.push("close");
      return true;
    }),
    closeAllSessions: vi.fn(),
  };
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function post(
  headers: Record<string, string> = SAME_ORIGIN,
  cookie: string | null = TOKEN,
  url = `${APP}/api/v1/auth/logout`,
) {
  return logout(
    new Request(url, {
      method: "POST",
      headers:
        cookie === null ? headers : { cookie: `__Host-ductus_session=${cookie}`, ...headers },
    }),
    deps,
  );
}

describe("POST /api/v1/auth/logout", () => {
  it.each([
    ["a cross-site origin", { "sec-fetch-site": "cross-site", origin: "https://napadac.test" }],
    ["a foreign origin", { origin: "https://napadac.test" }],
    ["no Origin", { "sec-fetch-site": "same-origin" }],
    ["Origin null", { origin: "null" }],
    ["a same-site but not same-origin fetch", { "sec-fetch-site": "same-site", origin: APP }],
  ])("N2: %s is refused before the session and the provider", async (_n, h) => {
    const response = await post(h);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(errors).toHaveBeenCalledWith("login failed", "logout", "cross_origin");
  });

  it.each([
    ["malformed", "nije-token"],
    ["unknown, closed or expired", "b".repeat(43)],
    ["a DEL", `${"c".repeat(42)}\u007f`],
    ["an NBSP", `${"d".repeat(41)} e`],
    ["a tab", `${"f".repeat(21)}\t${"g".repeat(21)}`],
  ])("N4: a %s cookie goes to closeSession and the answer does not tell", async (_n, value) => {
    const withNothing = await post(SAME_ORIGIN, null);
    expect(deps.closeSession).not.toHaveBeenCalled();
    deps.closeSession.mockResolvedValueOnce(false);
    const response = await post(SAME_ORIGIN, value);
    expect(deps.closeSession).toHaveBeenCalledExactlyOnceWith(value);
    expect(response.status).toBe(withNothing.status);
    expect(response.headers.get("location")).toBe(withNothing.headers.get("location"));
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(withNothing.headers.getSetCookie()).toEqual([CLEARED]);
  });

  it("N5: nothing from the query reaches the address", async () => {
    const query = "?post_logout_redirect_uri=https://napadac.test/&client_id=drugi&state=x";
    const response = await post(SAME_ORIGIN, TOKEN, `${APP}/api/v1/auth/logout${query}`);
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
  });

  it("N6: when the provider fails, the local sign-out stands and / follows", async () => {
    idp.state.next = { endSessionEndpoint: ENDPOINT, down: true };
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP}/`);
    expect(events[0]).toBe("close");
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(errors).toHaveBeenCalledWith("login failed", "end_session", expect.any(String));
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
  });

  it("N7: when closing fails, clears the cookie and goes to the provider, again on a resend", async () => {
    deps.closeSession
      .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "ECONNREFUSED" }))
      .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "40P01" }));
    for (const code of ["ECONNREFUSED", "40P01"]) {
      const response = await post();
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
      expect(response.headers.getSetCookie()).toEqual([CLEARED]);
      expect(errors).toHaveBeenCalledWith("login failed", "logout", `Error:${code}`);
    }
  });

  it("P1: closes this session first, then clears the cookie and goes to the provider", async () => {
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(deps.closeSession).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(deps.closeAllSessions).not.toHaveBeenCalled();
    expect(events[0]).toBe("close");
    expect(events.slice(1).every((event) => event === "provider")).toBe(true);
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    const everything = JSON.stringify([...response.headers]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(CLIENT_SECRET);
  });

  // Ported from Ductus tests/unit/auth/flow-logout.test.ts (OSN-T1): cases the
  // earlier port did not carry.
  const HOME = `${APP}/`;

  it("C5, C6, E1: the provider address holds client_id and the return address alone", async () => {
    const response = await post();
    const location = new URL(response.headers.get("location")!);
    expect([...location.searchParams.keys()].sort()).toEqual([
      "client_id",
      "post_logout_redirect_uri",
    ]);
    expect(JSON.stringify([...response.headers])).not.toContain("id_token_hint");
  });

  it("C1: nothing from the request headers reaches either address", async () => {
    const response = await post({
      ...SAME_ORIGIN,
      host: "napadac.test",
      "x-forwarded-host": "napadac.test",
      "x-forwarded-proto": "http",
      referer: "https://napadac.test/",
    });
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
  });

  it("B4: without a session cookie goes to the provider, without touching the database", async () => {
    const response = await post(SAME_ORIGIN, null);
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
  });

  it("B4: goes to the provider when the session was already closed or had expired", async () => {
    deps.closeSession.mockResolvedValueOnce(false);
    const response = await post();
    expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
  });

  it("DAN-99: a confirmed logout sent again goes to the provider when the second close fails", async () => {
    deps.closeSession
      .mockImplementationOnce(async () => true)
      .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    const first = await post();
    const second = await post();
    for (const response of [first, second]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(PROVIDER_LOGOUT);
      expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    }
    expect(deps.closeSession).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("login failed", "logout", "Error:ECONNREFUSED");
  });

  it("B2: without an end_session_endpoint the local logout stands and / follows", async () => {
    idp.state.next = {};
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(HOME);
    expect(deps.closeSession).toHaveBeenCalledWith(TOKEN);
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("C4: an endpoint without TLS is not used", async () => {
    idp.state.next = { endSessionEndpoint: "http://127.0.0.1:9443/session/end" };
    expect((await post()).headers.get("location")).toBe(HOME);
  });

  const MARKER = "napadac.test/provider-detail";
  it.each([
    ["is unreachable", { down: true }],
    [
      "answers discovery with 503",
      { endpointStatus: { path: "/.well-known/openid-configuration", status: 503 } },
    ],
    [
      "times out",
      {
        reject: {
          path: "/.well-known/openid-configuration",
          error: new DOMException(`timeout ${MARKER}`, "TimeoutError"),
        },
      },
    ],
    [
      "fails with a detailed message",
      { reject: { path: "/.well-known/openid-configuration", error: new Error(MARKER) } },
    ],
  ])("B1, E2: when the provider %s, the local logout stands and / follows", async (_n, next) => {
    idp.state.next = { endSessionEndpoint: ENDPOINT, ...next };
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(HOME);
    expect(deps.closeSession).toHaveBeenCalledWith(TOKEN);
    expect(events[0]).toBe("close");
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(errors).toHaveBeenCalledWith("login failed", "end_session", expect.any(String));
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(TOKEN);
  });

  it("#18: accepts a matching Origin when the browser sends no Sec-Fetch-Site", async () => {
    expect((await post({ origin: APP })).status).toBe(303);
  });

  it.each([
    ["none (typed or bookmarked)", { "sec-fetch-site": "none" }],
    ["none over this Origin", { "sec-fetch-site": "none", origin: APP }],
    [
      "Sec-Fetch-Site same-origin over another Origin (DAN-302 L2)",
      { "sec-fetch-site": "same-origin", origin: "https://zlo.test" },
    ],
    ["neither header", {}],
  ])("#18: refuses a logout from %s", async (_n, headers) => {
    const response = await post(headers);
    expect(response.status).toBe(403);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
