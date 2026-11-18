// A failed login ends on the sign-in page with one of two codes (DAN-1081):
// the attacks of the plan on Ductus#2031 that the server answers, against the
// real openid-client and the in-process provider. Values are invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGN_IN_FAILURE } from "../contracts/index.ts";
import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";
import { SESSION_COOKIE_NAME } from "../session/index.ts";

import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../test-support/test-idp/index.ts";
import {
  type AuthDeps,
  finishLogin,
  LOGIN_COOKIE_NAME,
  offSignInPage,
  startLogin,
} from "./auth-flow.ts";

const APP = "https://ductus.test";
const CALLBACK = `${APP}/api/v1/auth/callback`;
const CANARY = "KANARINAC-7f3a";
const config = loadAuthConfig({
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: CALLBACK,
});
const CLEARED = `${LOGIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const LIVE_SESSION = `${SESSION_COOKIE_NAME}=${"s".repeat(43)}`;

let idp: ReturnType<typeof createTestIdp>;
let deps: AuthDeps & {
  openSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
};
let logged: string[];

beforeEach(() => {
  idp = createTestIdp();
  deps = {
    config,
    oidc: createOidcClient(config, idp.fetch),
    openSession: vi.fn(async () => ({ ok: true as const, expires: new Date("2030-01-01") })),
    closeSession: vi.fn(async () => true),
    closeAllSessions: vi.fn(async () => undefined),
  };
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

async function begin(returnTo?: string) {
  const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await startLogin(new Request(`${APP}/api/v1/auth/login${query}`), deps);
  const attempt = response.headers.getSetCookie()[0] ?? "";
  return {
    authorize: new URL(response.headers.get("location") ?? ""),
    cookie: attempt.slice(0, attempt.indexOf(";")),
  };
}

const callback = (url: URL | string, cookie = "", host?: string) =>
  finishLogin(new Request(url, { headers: { cookie, ...(host ? { host } : {}) } }), deps);

/** Everything the browser sees of an answer. */
async function seen(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => name !== "set-cookie"),
    cookies: response.headers.getSetCookie(),
    body: await response.text(),
  };
}

/** A failure: 303 to the configured sign-in page with `code`, one log line, no session touched. */
async function expectFailure(response: Response, code: string, cookies = [CLEARED]) {
  const answer = await seen(response);
  expect(answer).toEqual({
    status: 303,
    headers: [
      ["cache-control", "no-store"],
      ["location", `${APP}/prijava?greska=${code}`],
      ["referrer-policy", "no-referrer"],
    ],
    cookies,
    body: "",
  });
  expect(SIGN_IN_FAILURE.codes.map((entry) => entry.code)).toContain(code);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(new RegExp(`^login failed \\S+ \\S+ ${code}$`, "u"));
  expect(JSON.stringify(answer) + logged.join("\n")).not.toContain(CANARY);
  expect(deps.closeSession).not.toHaveBeenCalled();
  return answer;
}

/** The provider stops answering, discovery included (a new client caches none). */
function providerDown(): void {
  idp.state.next = { down: true };
  deps.oidc = createOidcClient(config, idp.fetch);
}

/** The callback the provider sends after approving `authorize`. */
const approved = (authorize: URL) => idp.approve(authorize, CALLBACK);

describe("K2 K3 S6: every refusal looks the same to the browser", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["no attempt cookie", async () => callback(approved((await begin()).authorize))],
    [
      "a forged attempt cookie",
      async () => callback(approved((await begin()).authorize), `${LOGIN_COOKIE_NAME}=e30`),
    ],
    [
      "an attempt cookie over 1024 characters",
      async () =>
        callback(approved((await begin()).authorize), `${LOGIN_COOKIE_NAME}=${"a".repeat(1025)}`),
    ],
    [
      "another state (login CSRF: someone else's code)",
      async () => {
        const { authorize, cookie } = await begin();
        const url = approved(authorize);
        url.searchParams.set("state", "x".repeat(43));
        return callback(url, cookie);
      },
    ],
    [
      "another tab's attempt (another verifier)",
      async () => {
        const first = await begin();
        const second = await begin();
        const url = approved(first.authorize);
        url.searchParams.set("state", second.authorize.searchParams.get("state") ?? "");
        return callback(url, second.cookie);
      },
    ],
    [
      "another nonce",
      async () => {
        idp.state.next = { claims: (c) => ({ ...c, nonce: CANARY.padEnd(43, "n") }) };
        const { authorize, cookie } = await begin();
        return callback(approved(authorize), cookie);
      },
    ],
    [
      "userinfo for another subject",
      async () => {
        idp.state.next = { userinfo: (u) => ({ ...u, sub: CANARY }) };
        const { authorize, cookie } = await begin();
        return callback(approved(authorize), cookie);
      },
    ],
    [
      "no hrEduPersonUniqueID",
      async () => {
        idp.state.next = { userinfo: ({ hrEduPersonUniqueID: _gone, ...u }) => u };
        const { authorize, cookie } = await begin();
        return callback(approved(authorize), cookie);
      },
    ],
    [
      "two hrEduPersonUniqueID values",
      async () => {
        idp.state.next = { userinfo: (u) => ({ ...u, hrEduPersonUniqueID: [CANARY, "b@c.d"] }) };
        const { authorize, cookie } = await begin();
        return callback(approved(authorize), cookie);
      },
    ],
    ...(["refused", "conflict"] as const).map((reason): [string, () => Promise<Response>] => [
      `openSession ${reason}`,
      async () => {
        deps.openSession.mockResolvedValueOnce({ ok: false, reason });
        const { authorize, cookie } = await begin();
        return callback(approved(authorize), cookie);
      },
    ]),
  ];

  it.each(cases)("%s: login_failed, byte for byte the same answer", async (_name, run) => {
    const answer = await expectFailure(await run(), "login_failed");
    const { authorize } = await begin();
    logged = [];
    expect(await seen(await callback(approved(authorize)))).toEqual(answer);
    if (!_name.startsWith("openSession")) expect(deps.openSession).not.toHaveBeenCalled();
  });
});

describe("K5 V4: what the provider sends back on the callback", () => {
  async function providerSays(error: string, state?: string) {
    const { authorize, cookie } = await begin();
    const url = new URL(CALLBACK);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", `<script>${CANARY}</script>`);
    url.searchParams.set("error_uri", `https://${CANARY}.invalid/`);
    url.searchParams.set("state", state ?? authorize.searchParams.get("state") ?? "");
    return callback(url, cookie);
  }

  it("access_denied is login_failed, with nothing of the provider's text", async () => {
    await expectFailure(await providerSays("access_denied"), "login_failed");
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it.each(["temporarily_unavailable", "server_error"])(
    "%s for this attempt is provider_unavailable",
    async (error) => {
      await expectFailure(await providerSays(error), "provider_unavailable");
    },
  );

  it.each(["temporarily_unavailable", "server_error"])(
    "%s with another state is login_failed: the state is checked first",
    async (error) => {
      await expectFailure(await providerSays(error, CANARY.padEnd(43, "x")), "login_failed");
    },
  );
});

describe("R1 R2 R5: the Location is the configured origin and constants", () => {
  it("a forged Host on the callback or the login changes nothing", async () => {
    const { authorize, cookie } = await begin();
    const url = approved(authorize);
    url.searchParams.set("state", "x".repeat(43));
    const spoofed = new URL(url.pathname + url.search, "https://zlo.invalid");
    await expectFailure(await callback(spoofed, cookie, "zlo.invalid"), "login_failed");

    logged = [];
    providerDown();
    const login = await startLogin(new Request("https://zlo.invalid/api/v1/auth/login"), deps);
    await expectFailure(login, "provider_unavailable", []);
  });

  it("CR, LF, quotes and angle brackets in the query add no header or cookie", async () => {
    const { authorize, cookie } = await begin();
    const url = new URL(`${CALLBACK}?code=a%0d%0aSet-Cookie:%20x=1&state="<${CANARY}>%0d%0a`);
    url.searchParams.set("iss", `\r\nLocation: https://${CANARY}.invalid/`);
    expect(authorize.href).toContain("state=");
    await expectFailure(await callback(url, cookie), "login_failed");
  });
});

describe("R4 R6: no returnTo goes to the sign-in page", () => {
  it.each([
    "/rad/zadatak-1",
    "//evil.example",
    "/\\evil",
    "/%2e//evil",
    "/api/v1/auth/login",
    "/API/%61uth/login",
    "/prijava?greska=login_failed",
    "/rad‮\u0000",
    `/${"a".repeat(512)}`,
  ])("an attempt that stored %j fails to the same Location as one with none", async (path) => {
    const { authorize, cookie } = await begin(path);
    const url = approved(authorize);
    url.searchParams.set("state", "x".repeat(43));
    url.searchParams.set("returnTo", "/rad/zadatak-1");
    await expectFailure(await callback(url, cookie), "login_failed");
  });
});

describe("S1 S3: a failure never sets, clears or closes a session", () => {
  it("a cross-site GET of the callback or the login leaves a live session alone", async () => {
    const { authorize, cookie } = await begin();
    const url = approved(authorize);
    url.searchParams.set("state", "x".repeat(43));
    await expectFailure(await callback(url, `${cookie}; ${LIVE_SESSION}`), "login_failed");

    // A forged GET with no attempt at all, the cheapest one for another site.
    logged = [];
    await expectFailure(await callback(`${CALLBACK}?code=x&state=y`, LIVE_SESSION), "login_failed");

    logged = [];
    providerDown();
    const login = await startLogin(
      new Request(`${APP}/api/v1/auth/login`, { headers: { cookie: LIVE_SESSION } }),
      deps,
    );
    await expectFailure(login, "provider_unavailable", []);
  });

  it("openSession that throws is provider_unavailable and sets no session", async () => {
    deps.openSession.mockRejectedValueOnce(new Error(CANARY));
    const { authorize, cookie } = await begin();
    await expectFailure(
      await callback(approved(authorize), `${cookie}; ${LIVE_SESSION}`),
      "provider_unavailable",
    );
  });
});

describe("S2: one attempt opens at most one session", () => {
  it("two callbacks of one attempt at once: one session, the other login_failed", async () => {
    const { authorize, cookie } = await begin();
    const url = approved(authorize);
    const answers = await Promise.all([callback(url, cookie), callback(url, cookie)]);
    const locations = answers.map((a) => a.headers.get("location")).sort();
    expect(locations).toEqual([`${APP}/`, `${APP}/prijava?greska=login_failed`]);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
  });
});

describe("K1 K4: the codes sent are exactly the contract's", () => {
  it("the contract has two codes, none of them about a role", () => {
    expect(SIGN_IN_FAILURE.codes.map((entry) => entry.code)).toEqual([
      "login_failed",
      "provider_unavailable",
    ]);
  });

  it("every code of the contract is sent by some failure, and nothing else", async () => {
    const refused = await callback(`${CALLBACK}?code=x&state=y`);
    providerDown();
    const down = await startLogin(new Request(`${APP}/api/v1/auth/login`), deps);
    const sent = [refused, down].map((r) =>
      new URL(r.headers.get("location") ?? "").searchParams.getAll(SIGN_IN_FAILURE.param),
    );
    expect(sent).toEqual(SIGN_IN_FAILURE.codes.map((entry) => [entry.code]));
  });
});

describe("R4 S4: a login that succeeds never lands on the sign-in page", () => {
  it.each([
    "/prijava",
    "/prijava?greska=provider_unavailable",
    "/PRIJAVA?greska=login_failed",
    "/prijava/",
    "/prijava/x",
    "/prij%61va?greska=login_failed",
    "/%2570rijava",
    "/rad/../prijava",
    "/rad%2F..%2Fprijava",
  ])("an attempt that stored %j goes to the default page", async (path) => {
    const { authorize, cookie } = await begin(path);
    const answer = await callback(approved(authorize), cookie);
    expect(answer.headers.get("location")).toBe(`${APP}/`);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
  });

  it("offSignInPage sends any percent-encoded first segment to the default page", () => {
    for (const path of ["/%70rijava", "/rad%2Fx", "/%41", "/%"])
      expect(offSignInPage(path), path).toBe("/");
    expect(offSignInPage("/rad/%C5%A1kola?q=%2F")).toBe("/rad/%C5%A1kola?q=%2F");
  });

  it.each(["/prijavaa", "/rad/prijava", "/rad/zadatak-1?greska=login_failed"])(
    "an attempt that stored %j goes there",
    async (path) => {
      const { authorize, cookie } = await begin(path);
      const answer = await callback(approved(authorize), cookie);
      expect(answer.headers.get("location")).toBe(`${APP}${path}`);
    },
  );
});
