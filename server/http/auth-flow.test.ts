// Ported from Ductus tests/unit/auth/flow.test.ts at 078c780 (S-1E-a, DAN-808).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthConfig } from "../external/srce-auth/index.ts";
import {
  authTimeRefusal,
  finishLogin,
  LOGIN_COOKIE_NAME,
  SIGNED_OUT_COOKIE_NAME,
  startLogin,
  type AuthDeps,
} from "./auth-flow.ts";
import { createOidcClient, MAX_PROVIDER_RESPONSE_BYTES } from "../external/srce-auth/index.ts";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../session/index.ts";

import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../test-support/test-idp/index.ts";

// Attacks 1 to 7, 11 to 13, 16 to 18 and 20 of the B-6 plan (#154), against
// the real openid-client and an in-process provider. Values are invented.
const APP = "https://ductus.test";
const config = loadAuthConfig({
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${APP}/api/v1/auth/callback`,
});
const EXPIRES = new Date("2030-01-01T12:00:00Z");

let idp: ReturnType<typeof createTestIdp>;
let deps: AuthDeps & {
  openSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
};
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  idp = createTestIdp();
  deps = {
    config,
    oidc: createOidcClient(config, idp.fetch),
    openSession: vi.fn(async () => ({ ok: true as const, expires: EXPIRES })),
    closeSession: vi.fn(async () => true),
    closeAllSessions: vi.fn(async () => undefined),
  };
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function setCookies(response: Response): Map<string, string> {
  return new Map(response.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), c]));
}
const cookieValue = (header: string) => header.slice(header.indexOf("=") + 1, header.indexOf(";"));

/** Starts a login and returns the attempt cookie and the provider redirect. */
async function begin(path = "/api/v1/auth/login") {
  const response = await startLogin(new Request(`${APP}${path}`), deps);
  expect(response.status).toBe(303);
  const attempt = setCookies(response).get(LOGIN_COOKIE_NAME);
  expect(attempt).toBeDefined();
  return {
    authorize: new URL(response.headers.get("location")!),
    cookie: `${LOGIN_COOKIE_NAME}=${cookieValue(attempt!)}`,
  };
}

function callback(url: URL, cookie?: string, extra: Record<string, string> = {}) {
  return finishLogin(
    new Request(url, { headers: { ...(cookie ? { cookie } : {}), ...extra } }),
    deps,
  );
}

async function login() {
  const { authorize, cookie } = await begin();
  return callback(idp.approve(authorize, `${APP}/api/v1/auth/callback`), cookie);
}

async function expectRefused(response: Response, status = 400) {
  expect(response.status).toBe(status);
  expect(deps.openSession).not.toHaveBeenCalled();
  const cookies = setCookies(response);
  expect(cookies.has(SESSION_COOKIE_NAME)).toBe(false);
  expect(cookies.get(LOGIN_COOKIE_NAME)).toMatch(/Max-Age=0/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("Prijava nije dovršena");
}

const without = (claims: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(claims).filter(([k]) => k !== key));

describe("login", () => {
  it("opens a session for the identity in the verified tokens", async () => {
    const response = await login();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP}/`);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
    const input = deps.openSession.mock.calls[0]![0];
    expect(input).toMatchObject({
      issuer: ISSUER,
      subject: "sub-demo-1",
      uniqueId: "ana@demo.ductus.test",
      homeOrg: "demo.ductus.test",
    });

    const session = setCookies(response).get(SESSION_COOKIE_NAME)!;
    expect(hashSessionToken(cookieValue(session)).equals(input.tokenHash)).toBe(true);
  });

  it("#13 sets __Host- cookies: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain", async () => {
    const { authorize, cookie } = await begin();
    const attempt = cookie;
    expect(attempt.startsWith("__Host-")).toBe(true);
    const response = await callback(idp.approve(authorize, `${APP}/api/v1/auth/callback`), attempt);
    const cookies = setCookies(response);
    const session = cookies.get(SESSION_COOKIE_NAME)!;
    for (const header of [session, cookies.get(LOGIN_COOKIE_NAME)!]) {
      expect(header).toMatch(/; Path=\/;/);
      expect(header).toMatch(/; HttpOnly;/);
      expect(header).toMatch(/; Secure;/);
      expect(header).toMatch(/; SameSite=Lax;/);
      expect(header).not.toMatch(/domain=/i);
    }
    expect(session).toContain(`Expires=${EXPIRES.toUTCString()}`);
    expect(cookieValue(session)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("#4 sends a S256 challenge and the matching verifier", async () => {
    const { authorize } = await begin();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid profile");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${APP}/api/v1/auth/callback`);
    expect(await login().then((r) => r.status)).toBe(303);
    expect(idp.tokenRequests.at(-1)?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("#4 refuses when the verifier does not match the challenge", async () => {
    const first = await begin();
    const second = await begin();
    // Code issued for the first attempt, redeemed with the second's cookie (and so its verifier).
    const url = idp.approve(first.authorize, `${APP}/api/v1/auth/callback`);
    url.searchParams.set("state", second.authorize.searchParams.get("state")!);
    await expectRefused(await callback(url, second.cookie));
  });

  it("#1 refuses a callback whose state is not the attempt's", async () => {
    const { authorize, cookie } = await begin();
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    url.searchParams.set("state", "x".repeat(43));
    await expectRefused(await callback(url, cookie));
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("#1 refuses a callback without an attempt cookie, or with a forged one", async () => {
    const { authorize } = await begin();
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    await expectRefused(await callback(url));
    for (const forged of [
      "",
      "e30",
      "not-base64!",
      Buffer.from(JSON.stringify({ v: 1, state: "a" })).toString("base64url"),
    ]) {
      await expectRefused(await callback(url, `${LOGIN_COOKIE_NAME}=${forged}`));
    }
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("#2 a replayed callback opens no second session", async () => {
    const { authorize, cookie } = await begin();
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    expect((await callback(url, cookie)).status).toBe(303);
    deps.openSession.mockClear();
    // The browser no longer has the attempt cookie; an attacker who kept it
    // meets a code the provider already redeemed.
    await expectRefused(await callback(url));
    await expectRefused(await callback(url, cookie));
  });

  it("#3 refuses an ID token with another nonce, or none", async () => {
    idp.state.next = { claims: (c) => ({ ...c, nonce: "n".repeat(43) }) };
    await expectRefused(await login());
    idp.state.next = { claims: (c) => without(c, "nonce") };
    await expectRefused(await login());
  });

  it.each([
    ["another issuer", (c: Record<string, unknown>) => ({ ...c, iss: "https://zlo.test" })],
    ["another audience", (c: Record<string, unknown>) => ({ ...c, aud: "someone-else" })],
    [
      "expired beyond the tolerance",
      (c: Record<string, unknown>) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 120 }),
    ],
    [
      "not yet valid",
      (c: Record<string, unknown>) => ({ ...c, nbf: Math.floor(Date.now() / 1000) + 600 }),
    ],
    ["no subject", (c: Record<string, unknown>) => without(c, "sub")],
  ])("#5 refuses an ID token from %s", async (_name, claims) => {
    idp.state.next = { claims };
    await expectRefused(await login());
  });

  it.each(["none", "HS256", "foreign-key", "unknown-kid"] as const)(
    "#6 #7 refuses an ID token signed with %s",
    async (signing) => {
      idp.state.next = { signing };
      await expectRefused(await login());
    },
  );

  it("#8 refuses userinfo for another subject", async () => {
    idp.state.next = { userinfo: (u) => ({ ...u, sub: "sub-other" }) };
    await expectRefused(await login());
  });

  it("refuses a login without hrEduPersonUniqueID with the same page as a refused institution", async () => {
    idp.state.next = { userinfo: (u) => without(u, "hrEduPersonUniqueID") };
    const missing = await login();
    const missingPage = await missing.clone().text();
    await expectRefused(missing, 403);

    idp.state.next = {};
    deps.openSession.mockResolvedValueOnce({ ok: false, reason: "refused" });
    const refused = await login();
    expect(refused.status).toBe(403);
    expect(setCookies(refused).has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await refused.text()).toBe(missingPage);
  });

  it("#11 shows the unavailable page when the provider is down or failing", async () => {
    idp.state.next = { down: true };
    const start = await startLogin(new Request(`${APP}/api/v1/auth/login`), deps);
    expect(start.status).toBe(503);
    expect(setCookies(start).has(LOGIN_COOKIE_NAME)).toBe(false);
    expect(await start.text()).toContain("trenutačno ne odgovara");

    idp.state.next = {};
    const { authorize, cookie } = await begin();
    idp.state.next = { tokenStatus: 502 };
    await expectRefused(
      await callback(idp.approve(authorize, `${APP}/api/v1/auth/callback`), cookie),
      503,
    );
  });

  it("#11 refuses a 5 MB userinfo without reading it whole", async () => {
    let sent = 0;
    idp.state.next = {
      userinfoBody: () =>
        new ReadableStream({
          pull(controller) {
            if (sent >= 5 * 1024 * 1024) return controller.close();
            sent += 64 * 1024;
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
          },
        }),
    };
    await expectRefused(await login());
    expect(sent).toBeLessThanOrEqual(MAX_PROVIDER_RESPONSE_BYTES + 2 * 64 * 1024);
  });

  it("#12 closes a session cookie the browser already had and issues a new token", async () => {
    const planted = "p".repeat(43);
    const { authorize, cookie } = await begin();
    const response = await callback(
      idp.approve(authorize, `${APP}/api/v1/auth/callback`),
      `${cookie}; ${SESSION_COOKIE_NAME}=${planted}`,
    );
    expect(response.status).toBe(303);
    expect(deps.closeSession).toHaveBeenCalledWith(planted);
    expect(cookieValue(setCookies(response).get(SESSION_COOKIE_NAME)!)).not.toBe(planted);
  });

  it("#16 takes the identity from the tokens, never from the callback query", async () => {
    const { authorize, cookie } = await begin();
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    for (const [k, v] of Object.entries({
      sub: "evil",
      hrEduPersonUniqueID: "evil@zlo.test",
      hrEduPersonHomeOrg: "zlo.test",
    })) {
      url.searchParams.append(k, v);
    }
    await callback(url, cookie);
    expect(deps.openSession.mock.calls[0]?.[0]).toMatchObject({
      subject: "sub-demo-1",
      uniqueId: "ana@demo.ductus.test",
      homeOrg: "demo.ductus.test",
    });
  });

  it("#17 returns to the path stored with the attempt, never one from the callback", async () => {
    const { authorize, cookie } = await begin("/api/v1/auth/login?returnTo=%2Frad%3Fx%3D1");
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    url.searchParams.set("returnTo", "https://zlo.test/");
    const response = await callback(url, cookie);
    expect(response.headers.get("location")).toBe(`${APP}/rad?x=1`);

    for (const evil of [
      "https://zlo.test/",
      "//zlo.test",
      "/.//zlo.test",
      "/API/auth/login",
      "/%61pi/auth/login",
    ]) {
      const attempt = await begin(`/api/v1/auth/login?returnTo=${encodeURIComponent(evil)}`);
      const done = await callback(
        idp.approve(attempt.authorize, `${APP}/api/v1/auth/callback`),
        attempt.cookie,
      );
      expect(done.headers.get("location")).toBe(`${APP}/`);
    }
  });

  it("#17 keeps the percent-encoding of the stored path in Location", async () => {
    const stored = "/rad/%C5%A1kola?q=a%20b%26c#x%20y";
    const { authorize, cookie } = await begin(
      `/api/v1/auth/login?returnTo=${encodeURIComponent(stored)}`,
    );
    const response = await callback(idp.approve(authorize, `${APP}/api/v1/auth/callback`), cookie);
    expect(response.headers.get("location")).toBe(`${APP}${stored}`);
  });

  it("uses the configured redirect URI, never the Host of the callback request", async () => {
    const { authorize, cookie } = await begin();
    const url = idp.approve(authorize, `${APP}/api/v1/auth/callback`);
    const spoofed = new URL(url.pathname + url.search, "https://zlo.test");
    const response = await callback(spoofed, cookie, { host: "zlo.test" });
    expect(response.status).toBe(303);
    expect(idp.tokenRequests.at(-1)?.get("redirect_uri")).toBe(`${APP}/api/v1/auth/callback`);
    expect(response.headers.get("location")).toBe(`${APP}/`);
  });

  it("logs a stage and a code, never a value from the provider or the request", async () => {
    idp.state.next = { claims: (c) => ({ ...c, nonce: "n".repeat(43) }) };
    await login();
    idp.state.next = { userinfo: (u) => ({ ...u, hrEduPersonUniqueID: "‮ana@demo.ductus.test" }) };
    await login();
    const logged = JSON.stringify(errors.mock.calls);
    expect(errors).toHaveBeenCalled();
    for (const value of [
      "ana@demo.ductus.test",
      "sub-demo-1",
      "demo.ductus.test",
      "n".repeat(43),
      CLIENT_SECRET,
    ]) {
      expect(logged).not.toContain(value);
    }
  });

  // F-042 (DAN-174): one account key per issuer, whichever way it is spelled.
  it.each([
    ["the provider adds a slash after the host", ISSUER, `${ISSUER}/`],
    ["the provider writes the scheme in capitals", ISSUER, ISSUER.replace("https", "HTTPS")],
    ["the configuration adds a slash after the host", `${ISSUER}/`, ISSUER],
  ])(
    "opens the session under the configured issuer when %s",
    async (_name, configured, spelled) => {
      const spelledConfig = loadAuthConfig({
        NODE_ENV: "test",
        DUCTUS_AUTH_PROVIDER: "fake-oidc",
        OIDC_ISSUER: configured,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: CLIENT_SECRET,
        OIDC_REDIRECT_URI: `${APP}/api/v1/auth/callback`,
      });
      idp = createTestIdp(undefined, spelled);
      deps.config = spelledConfig;
      deps.oidc = createOidcClient(spelledConfig, idp.fetch);

      const response = await login();
      expect(response.status).toBe(303);
      expect(deps.openSession).toHaveBeenCalledTimes(1);
      expect(deps.openSession.mock.calls[0]![0].issuer).toBe(ISSUER);
    },
  );

  // F-123: openid-client skips its issuer check for a "/.well-known/" URL.
  // loadAuthConfig refuses one; the client fails closed even if one reaches it.
  it("opens no session when the discovered issuer differs from the configured one", async () => {
    const wellKnown = { ...config, issuer: new URL(`${ISSUER}/.well-known/openid-configuration`) };
    deps.config = wellKnown;
    deps.oidc = createOidcClient(wellKnown, idp.fetch);

    const start = await startLogin(new Request(`${APP}/api/v1/auth/login`), deps);
    expect(start.status).toBe(503);
    expect(start.headers.get("location")).toBeNull();
    await expect(
      deps.oidc.verify(new URL(`${APP}/api/v1/auth/callback?code=x&state=y`), {
        state: "y",
        nonce: "n",
        codeVerifier: "v".repeat(43),
      }),
    ).rejects.toThrow("discovered issuer does not match OIDC_ISSUER");
    expect(deps.openSession).not.toHaveBeenCalled();
  });
});

// INT-20b: after an explicit sign-out the next login asks the provider to
// sign in again (prompt=login), until a login succeeds. INT-20d: it also
// sends max_age=0 and needs an auth_time from after the attempt began.
describe("the first login after a sign-out", () => {
  const MARK = `${SIGNED_OUT_COOKIE_NAME}=1`;
  const CLEARED_MARK = `${SIGNED_OUT_COOKIE_NAME}=; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const CALLBACK = `${APP}/api/v1/auth/callback`;
  const start = (cookie?: string) =>
    startLogin(
      new Request(`${APP}/api/v1/auth/login`, { headers: cookie ? { cookie } : {} }),
      deps,
    );
  /** The attempt record as stored in its cookie. */
  const attemptOf = (response: Response): Record<string, unknown> =>
    JSON.parse(
      Buffer.from(cookieValue(setCookies(response).get(LOGIN_COOKIE_NAME)!), "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
  const now = () => Math.floor(Date.now() / 1000);
  /** Starts a login with the mark; the provider answers with this auth_time (or none). */
  async function afterSignOut(authTime: (freshSince: number) => unknown) {
    const response = await start(MARK);
    const freshSince = attemptOf(response).freshSince as number;
    const value = authTime(freshSince);
    idp.state.next = {
      claims: (c) => (value === undefined ? without(c, "auth_time") : { ...c, auth_time: value }),
    };
    const attempt = setCookies(response).get(LOGIN_COOKIE_NAME)!;
    const authorize = new URL(response.headers.get("location")!);
    return callback(
      idp.approve(authorize, CALLBACK),
      `${LOGIN_COOKIE_NAME}=${cookieValue(attempt)}; ${MARK}`,
    );
  }

  it("sends prompt=login and max_age=0 when the sign-out mark is there", async () => {
    const response = await start(`other=x; ${MARK}`);
    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.searchParams.getAll("prompt")).toEqual(["login"]);
    expect(authorize.searchParams.getAll("max_age")).toEqual(["0"]);
  });

  it.each([
    ["no cookie", undefined],
    ["another cookie", "other=1"],
    ["a mark with another value", `${SIGNED_OUT_COOKIE_NAME}=0`],
    ["an empty mark", `${SIGNED_OUT_COOKIE_NAME}=`],
  ])("sends no prompt and no max_age with %s", async (_n, cookie) => {
    const response = await start(cookie);
    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.searchParams.has("prompt")).toBe(false);
    expect(authorize.searchParams.has("max_age")).toBe(false);
    // The attempt record is the one from before INT-20d.
    expect(Object.keys(attemptOf(response)).sort()).toEqual(
      ["codeVerifier", "nonce", "returnTo", "state", "v"].sort(),
    );
  });

  it("keeps the start of the attempt on the attempt record, not in a cookie of its own", async () => {
    const before = now();
    const response = await start(MARK);
    const record = attemptOf(response);
    expect(record.freshSince).toBeGreaterThanOrEqual(before);
    expect(record.freshSince).toBeLessThanOrEqual(now());
    expect([...setCookies(response).keys()]).toEqual([LOGIN_COOKIE_NAME]);
  });

  it("leaves the mark in place when the login only starts", async () => {
    const response = await start(MARK);
    expect(setCookies(response).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it("clears the mark once the login succeeds with a fresh auth_time", async () => {
    const done = await afterSignOut(() => now());
    expect(done.status).toBe(303);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
    expect(setCookies(done).get(SIGNED_OUT_COOKIE_NAME)).toBe(CLEARED_MARK);
  });

  it("accepts an auth_time a little before the attempt, within the clock tolerance", async () => {
    const skew = config.clockToleranceSeconds;
    expect(skew).toBeGreaterThan(0);
    const done = await afterSignOut((since) => since - skew);
    expect(done.status).toBe(303);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no auth_time", () => undefined, "missing"],
    ["an auth_time from before the attempt", (since: number) => since - 3600, "stale"],
    [
      "an auth_time just past the clock tolerance",
      (since: number) => since - config.clockToleranceSeconds - 1,
      "stale",
    ],
  ])("refuses a callback with %s and keeps the mark", async (_n, authTime, code) => {
    const failed = await afterSignOut(authTime);
    await expectRefused(failed);
    expect(setCookies(failed).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
    expect(errors).toHaveBeenCalledWith("login failed", "auth_time", code);
  });

  // INT-20e: auth_time is bounded above as iat is, by this clock plus the skew.
  describe("with the clock held still", () => {
    const START = Date.UTC(2030, 0, 1, 12, 0, 0);
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: START }));
    afterEach(() => vi.useRealTimers());

    it("accepts an auth_time at the clock plus the tolerance", async () => {
      const done = await afterSignOut(() => now() + config.clockToleranceSeconds);
      expect(done.status).toBe(303);
      expect(deps.openSession).toHaveBeenCalledTimes(1);
      expect(setCookies(done).get(SIGNED_OUT_COOKIE_NAME)).toBe(CLEARED_MARK);
    });

    it("refuses an auth_time one second past the clock plus the tolerance, and keeps the mark", async () => {
      const failed = await afterSignOut(() => now() + config.clockToleranceSeconds + 1);
      await expectRefused(failed);
      expect(setCookies(failed).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
      expect(errors).toHaveBeenCalledWith("login failed", "auth_time", "future");
    });

    it("asks nothing of auth_time on a login without the mark, a later one included", async () => {
      idp.state.next = { claims: (c) => ({ ...c, auth_time: now() + 3600 }) };
      expect((await login()).status).toBe(303);
      expect(errors).not.toHaveBeenCalled();
    });
  });

  it("names why an auth_time does not count", () => {
    const since = 1_900_000_000;
    const at = (authTime: unknown, nowSeconds = since) =>
      authTimeRefusal(authTime, since, 60, nowSeconds);
    expect(at(since)).toBeUndefined();
    expect(at(since - 60)).toBeUndefined();
    expect(at(since - 61)).toBe("stale");
    expect(at(since + 60)).toBeUndefined();
    expect(at(since + 61)).toBe("future");
    expect(at(since + 100, since + 40)).toBeUndefined();
    expect(at(since + 101, since + 40)).toBe("future");
    for (const value of [undefined, null, "1900000000", 1.5, 0, -1]) {
      expect(at(value)).toBe("missing");
    }
  });

  // INT-20e: while the mark is there, an attempt started without it does not
  // sign in and does not clear the mark.
  it("refuses an attempt started without the mark while the mark is there, and keeps it", async () => {
    const { authorize, cookie } = await begin();
    const url = idp.approve(authorize, CALLBACK);
    const refused = await callback(url, `${cookie}; ${MARK}`);
    await expectRefused(refused);
    expect(setCookies(refused).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
    expect(idp.tokenRequests).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith("login failed", "callback", "attempt_without_start");

    // The same callback without the mark signs in and touches no mark.
    const done = await callback(url, cookie);
    expect(done.status).toBe(303);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
    expect(setCookies(done).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it.each([
    ["a mark with another value", `${SIGNED_OUT_COOKIE_NAME}=0`],
    ["an empty mark", `${SIGNED_OUT_COOKIE_NAME}=`],
  ])("lets an attempt without the mark through with %s, as startLogin does", async (_n, mark) => {
    const { authorize, cookie } = await begin();
    const done = await callback(idp.approve(authorize, CALLBACK), `${cookie}; ${mark}`);
    expect(done.status).toBe(303);
    expect(setCookies(done).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it("refuses an auth_time that is not a whole number of seconds, as a missing one", async () => {
    // The library itself refuses a non-numeric auth_time, so a verified login
    // carrying one is made here, behind the real verification.
    const real = deps.oidc;
    deps.oidc = {
      ...real,
      verify: async (url, checks) => {
        const verified = await real.verify(url, checks);
        return { ...verified, idToken: { ...verified.idToken, auth_time: String(now()) } };
      },
    };
    const failed = await afterSignOut(() => undefined);
    await expectRefused(failed);
    expect(setCookies(failed).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
    expect(errors).toHaveBeenCalledWith("login failed", "auth_time", "missing");
  });

  it("keeps the mark when the callback has no attempt, so the next attempt asks again", async () => {
    const { authorize } = await begin();
    const failed = await callback(idp.approve(authorize, CALLBACK), MARK);
    expect(failed.status).toBe(400);
    expect(setCookies(failed).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it("keeps the mark when the provider's answer fails verification", async () => {
    const response = await start(MARK);
    const attempt = setCookies(response).get(LOGIN_COOKIE_NAME)!;
    // The ID token carries another nonce, though its auth_time is fresh.
    idp.state.next = { claims: (c) => ({ ...c, nonce: "n".repeat(43), auth_time: now() }) };
    const refused = await callback(
      idp.approve(new URL(response.headers.get("location")!), CALLBACK),
      `${LOGIN_COOKIE_NAME}=${cookieValue(attempt)}; ${MARK}`,
    );
    await expectRefused(refused);
    expect(setCookies(refused).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
    expect(errors).toHaveBeenCalledWith("login failed", "verify", expect.any(String));
    expect(errors).not.toHaveBeenCalledWith("login failed", "auth_time", expect.anything());
  });

  it("keeps the mark when the provider is down at the callback", async () => {
    const response = await start(MARK);
    const attempt = setCookies(response).get(LOGIN_COOKIE_NAME)!;
    const url = idp.approve(new URL(response.headers.get("location")!), CALLBACK);
    idp.state.next = { down: true };
    const failed = await callback(url, `${LOGIN_COOKIE_NAME}=${cookieValue(attempt)}; ${MARK}`);
    await expectRefused(failed, 503);
    expect(setCookies(failed).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it("refuses an attempt record whose start is not a whole number of seconds", async () => {
    const { authorize, cookie } = await begin();
    const record = JSON.parse(
      Buffer.from(cookie.slice(cookie.indexOf("=") + 1), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    for (const freshSince of ["1", 1.5, -1, 0, null]) {
      const forged = Buffer.from(JSON.stringify({ ...record, freshSince })).toString("base64url");
      const response = await callback(
        idp.approve(authorize, CALLBACK),
        `${LOGIN_COOKIE_NAME}=${forged}`,
      );
      await expectRefused(response);
    }
    expect(idp.tokenRequests).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith("login failed", "callback", "no_attempt");
  });

  it("does not touch the mark on a login without one", async () => {
    const response = await login();
    expect(response.status).toBe(303);
    expect(setCookies(response).has(SIGNED_OUT_COOKIE_NAME)).toBe(false);
  });

  it("asks nothing of auth_time on a login without the mark", async () => {
    // The default ID token of the test provider has no auth_time at all.
    expect((await login()).status).toBe(303);
    idp.state.next = { claims: (c) => ({ ...c, auth_time: now() - 3600 }) };
    expect((await login()).status).toBe(303);
    expect(deps.openSession).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });
});
