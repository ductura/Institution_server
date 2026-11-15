// Port of the checkMutationRequest part of Ductus
// src/server/http/mutation-request.test.ts at d52a92c3 (#155 item 8), on
// IncomingMessage. The readBodyWithLimit part follows with part a2 (DAN-777).
// Origins below use .invalid and are invented.
import { type IncomingMessage, METHODS, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import {
  checkMutationRequest,
  isCanonicalOrigin,
  originLayer,
  SAFE_METHODS,
} from "./mutation-request.ts";

const ORIGIN = "https://ductura.invalid";

// Only what the check reads: the method and the headers as Node keeps them
// apart (headersDistinct), so a header sent twice is two entries.
function request(method: string, headers: Record<string, string[]> = {}): IncomingMessage {
  return { method, headersDistinct: headers } as unknown as IncomingMessage;
}
const post = (headers: Record<string, string[]>, method = "POST") => request(method, headers);

describe("checkMutationRequest (#155 item 8)", () => {
  it("accepts a same-origin POST with and without Sec-Fetch-Site", () => {
    const withSite = post({ origin: [ORIGIN], "sec-fetch-site": ["same-origin"] });
    expect(checkMutationRequest(withSite, ORIGIN)).toEqual({ ok: true });
    expect(checkMutationRequest(post({ origin: [ORIGIN] }), ORIGIN)).toEqual({ ok: true });
  });

  it("refuses a missing, empty or opaque Origin even when Sec-Fetch-Site says same-origin", () => {
    for (const origin of [undefined, "", "null"]) {
      const headers: Record<string, string[]> = { "sec-fetch-site": ["same-origin"] };
      if (origin !== undefined) headers.origin = [origin];
      expect(checkMutationRequest(post(headers), ORIGIN), String(origin)).toEqual({
        ok: false,
        status: 403,
        reason: "origin_missing",
      });
    }
  });

  it.each([
    "https://evil.invalid",
    "http://ductura.invalid",
    "https://ductura.invalid:8443",
    "https://sub.ductura.invalid",
    "https://DUCTURA.invalid",
    "https://ductura.invalid/",
    "https://ductura.invalid.evil.invalid",
    `${ORIGIN}, ${ORIGIN}`,
    ` ${ORIGIN}`,
  ])("refuses the foreign or non-canonical Origin %j", (origin) => {
    expect(checkMutationRequest(post({ origin: [origin] }), ORIGIN)).toEqual({
      ok: false,
      status: 403,
      reason: "origin_mismatch",
    });
  });

  it("refuses Origin sent twice, even when both copies are ours", () => {
    expect(checkMutationRequest(post({ origin: [ORIGIN, ORIGIN] }), ORIGIN)).toMatchObject({
      reason: "origin_mismatch",
    });
  });

  it.each([["cross-site"], ["same-site"], ["none"], [""], ["same-origin", "same-origin"]])(
    "refuses Sec-Fetch-Site %j from our origin",
    (...sites) => {
      const headers = { origin: [ORIGIN], "sec-fetch-site": sites };
      expect(checkMutationRequest(post(headers), ORIGIN)).toEqual({
        ok: false,
        status: 403,
        reason: "cross_site",
      });
    },
  );

  it("refuses every state-changing request when no origin is configured", () => {
    expect(checkMutationRequest(post({ origin: [ORIGIN] }), null)).toMatchObject({
      reason: "origin_mismatch",
    });
    expect(checkMutationRequest(post({ origin: ["null"] }), null)).toMatchObject({
      reason: "origin_missing",
    });
  });

  // The whole input, not a sample: every method Node parses.
  it.each(METHODS)("%s is safe only if it is GET, HEAD or OPTIONS", (method) => {
    const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const foreign = checkMutationRequest(
      request(method, { origin: ["https://evil.invalid"] }),
      ORIGIN,
    );
    const bare = checkMutationRequest(request(method), ORIGIN);
    expect([foreign.ok, bare.ok]).toEqual([safe, safe]);
    expect(SAFE_METHODS.has(method)).toBe(safe);
  });

  it.each(["get", "Get", "GET ", "", "BREW"])(
    "treats the method name %j as state-changing",
    (method) => {
      expect(checkMutationRequest(request(method), ORIGIN).ok).toBe(false);
    },
  );

  it("refuses with codes the contracts define as 403", () => {
    const codes = new Set(
      ROUTES.flatMap((route) => route.errors.filter((e) => e.status === 403).map((e) => e.code)),
    );
    for (const code of ["origin_missing", "origin_mismatch", "cross_site"]) {
      expect(codes.has(code), code).toBe(true);
    }
  });
});

describe("originLayer", () => {
  it("throws on a misconfigured expected origin instead of matching anything", () => {
    for (const bad of [
      "null",
      "https://ductura.invalid/",
      "ftp://ductura.invalid",
      "ductura.invalid",
      "",
    ]) {
      expect(isCanonicalOrigin(bad), bad).toBe(false);
      expect(() => originLayer(bad), bad).toThrow(/bare scheme/u);
    }
    expect(isCanonicalOrigin(ORIGIN)).toBe(true);
    expect(isCanonicalOrigin("http://127.0.0.1:4000")).toBe(true);
  });

  it("answers a refusal itself and never touches the body", async () => {
    const answer: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const set = new Map<string, string>();
    const response = {
      headersSent: false,
      hasHeader: (key: string) => set.has(key.toLowerCase()),
      setHeader: (key: string, value: string) => set.set(key.toLowerCase(), value),
      writeHead(status: number, headers: Record<string, string>) {
        answer.status = status;
        answer.headers = { ...Object.fromEntries(set), ...headers };
      },
      end: (body: string) => (answer.body = body),
    } as unknown as ServerResponse;
    const touched: string[] = [];
    const req = new Proxy(post({ origin: ["https://evil.invalid"] }), {
      get(target, key) {
        if (key === "on" || key === "read" || key === "pipe" || key === Symbol.asyncIterator) {
          touched.push(String(key));
        }
        return Reflect.get(target, key) as unknown;
      },
    });
    expect(await originLayer(ORIGIN)(req, response)).toBe("done");
    expect([answer.status, JSON.parse(answer.body ?? "")]).toEqual([
      403,
      { error: "origin_mismatch" },
    ]);
    expect(answer.headers?.["x-frame-options"]).toBe("DENY");
    expect(touched).toEqual([]);
  });
});
