import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backchannelLogout,
  MAX_BACKCHANNEL_BODY_BYTES,
  type BackchannelDeps,
} from "./backchannel.ts";
import type { BackchannelLogout } from "../database/index.ts";
import type { LogoutVerification, LogoutVerifier } from "../external/srce-auth/index.ts";

// DAN-474: the back-channel logout route (attack plan #1620: A1, A2, A5, B1, E4, G2, G3, G5).
// The verifier is a fake port here (docs/server-map.md §2); the real one,
// against the in-process provider, is covered by
// server/external/srce-auth/logout-verifier.test.ts (A1, A5, G3, G4).
// Every identifier is invented.
const APP = "https://ductus.test";
const ISSUER = "http://127.0.0.1:9400";
const LOGOUT_URL = `${APP}/api/auth/backchannel-logout`;
const SUB = "sub-demo-bc";
const SID = "sid-demo-bc-1";
const JTI = "jti-demo-bc-1";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLWRlbW8";
const VALID: LogoutVerification = { ok: true, sub: SUB, sid: SID, jti: JTI };

let verify: ReturnType<typeof vi.fn<LogoutVerifier["verify"]>>;
let port: ReturnType<typeof vi.fn<BackchannelLogout>>;
let deps: BackchannelDeps;
let errors: ReturnType<typeof vi.spyOn>;

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(LOGOUT_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

const form = (token: string) => new URLSearchParams({ logout_token: token }).toString();

beforeEach(() => {
  verify = vi.fn<LogoutVerifier["verify"]>(async () => VALID);
  port = vi.fn<BackchannelLogout>(async () => ({ ok: true, closed: 1 }));
  deps = { verifier: { accountIssuer: ISSUER, verify }, backchannelLogout: port };
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
});

function logged(): string {
  return JSON.stringify(errors.mock.calls);
}

describe("backchannel logout route", () => {
  it("A1: closes what a valid token names and answers 200 with no-store and no body", async () => {
    const response = await backchannelLogout(post(form(TOKEN)), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(port).toHaveBeenCalledWith({ issuer: ISSUER, subject: SUB, sid: SID, jti: JTI });
  });

  it("C5, C6: answers 200 when nothing matched (§2.8)", async () => {
    port.mockResolvedValueOnce({ ok: true, closed: 0 });
    expect((await backchannelLogout(post(form(TOKEN)), deps)).status).toBe(200);
  });

  it("G2: trusts no cookie, origin or session named by the caller", async () => {
    const request = post(form(TOKEN), {
      cookie: "__Host-ductus_session=" + "x".repeat(43),
      origin: "https://elsewhere.test",
      "sec-fetch-site": "cross-site",
    });
    expect((await backchannelLogout(request, deps)).status).toBe(200);
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]![0]).toEqual({ issuer: ISSUER, subject: SUB, sid: SID, jti: JTI });
  });

  it.each([
    [
      "no content type",
      () => new Request(LOGOUT_URL, { method: "POST", body: "logout_token=a.b.c" }),
    ],
    [
      "JSON",
      () => post(JSON.stringify({ logout_token: "a.b.c" }), { "content-type": "application/json" }),
    ],
    ["no token", () => post("other=1")],
    ["an empty token", () => post("logout_token=")],
    ["two tokens", () => post(`${form(TOKEN)}&${form(TOKEN)}`)],
    [
      "a declared body over the limit",
      () => post("logout_token=a", { "content-length": String(MAX_BACKCHANNEL_BODY_BYTES + 1) }),
    ],
    [
      "a streamed body over the limit",
      () => post(`logout_token=${"a".repeat(MAX_BACKCHANNEL_BODY_BYTES)}`),
    ],
    [
      "a body that is not UTF-8",
      () =>
        new Request(LOGOUT_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new Uint8Array([0x6c, 0x3d, 0xff, 0xfe]),
        }),
    ],
  ])("A2: refuses %s with 400 before anything is closed", async (ignoredName, request) => {
    const response = await backchannelLogout(request(), deps);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(verify).not.toHaveBeenCalled();
    expect(port).not.toHaveBeenCalled();
  });

  it("A5: refuses a token the verifier rejects with 400", async () => {
    verify.mockResolvedValueOnce({ ok: false, reason: "invalid", code: "signature" });
    const response = await backchannelLogout(post(form(TOKEN)), deps);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(port).not.toHaveBeenCalled();
    expect(logged()).toContain("signature");
  });

  it("B1: refuses a replayed jti with 400", async () => {
    port.mockResolvedValueOnce({ ok: false, reason: "replayed" });
    expect((await backchannelLogout(post(form(TOKEN)), deps)).status).toBe(400);
    expect(logged()).toContain("replayed");
  });

  it.each([["provider_unavailable" as const], ["keys" as const]])(
    "G3: answers 503 when the verifier reports %s",
    async (code) => {
      verify.mockResolvedValueOnce({ ok: false, reason: "unavailable", code });
      const response = await backchannelLogout(post(form(TOKEN)), deps);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(port).not.toHaveBeenCalled();
      expect(logged()).toContain(code);
    },
  );

  it("G3: answers 503 when the verifier port throws", async () => {
    verify.mockRejectedValueOnce(new Error("unexpected"));
    const response = await backchannelLogout(post(form(TOKEN)), deps);
    expect(response.status).toBe(503);
    expect(port).not.toHaveBeenCalled();
  });

  it("G5: answers 503 when the database fails", async () => {
    port.mockRejectedValueOnce(
      Object.assign(new Error("connection terminated"), { code: "57P01" }),
    );
    expect((await backchannelLogout(post(form(TOKEN)), deps)).status).toBe(503);
  });

  it("E4: logs a stage and a code, never the token, sub, sid or jti", async () => {
    const token = TOKEN;
    verify.mockResolvedValueOnce({ ok: false, reason: "invalid", code: "audience" });
    await backchannelLogout(post(form(token)), deps);
    port.mockResolvedValueOnce({ ok: false, reason: "replayed" });
    await backchannelLogout(post(form(TOKEN)), deps);
    const text = logged();
    expect(errors).toHaveBeenCalled();
    for (const secret of [token, token.split(".")[2]!, SUB, SID, JTI])
      expect(text).not.toContain(secret);
  });
});
