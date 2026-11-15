// Port of Ductus src/server/http/mutation-request.test.ts at d52a92c3
// (#155 items 8, 10 and 12), on IncomingMessage: checkMutationRequest (part
// a1) and readBodyWithLimit (part a2, DAN-777). The body tests use a Readable
// that records how far it was pulled, in place of a Web ReadableStream.
// Origins below use .invalid and are invented.
import { type IncomingMessage, METHODS, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import {
  checkMutationRequest,
  declaredLengthRefusal,
  isCanonicalOrigin,
  originLayer,
  readBodyWithLimit,
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
      getHeaderNames: () => [...set.keys()],
      removeHeader: (key: string) => set.delete(key.toLowerCase()),
      addTrailers: () => undefined,
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
    const sent: unknown = JSON.parse(answer.body ?? "");
    // 403 is a oneOf in v1, so the body stays {error} (v1Error); the id is in the header.
    expect([answer.status, sent]).toEqual([403, { error: "origin_mismatch" }]);
    expect(answer.headers?.["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(answer.headers?.["x-frame-options"]).toBe("DENY");
    expect(touched).toEqual([]);
  });
});

/** A body that produces chunks on demand and records how far it was read. */
function tracked(chunkSize: number, chunks: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0 };
  const body = new Readable({
    highWaterMark: chunkSize,
    read() {
      if (state.pulled === chunks) {
        this.push(null);
        return;
      }
      state.pulled += 1;
      this.push(Buffer.alloc(chunkSize, 0x61));
    },
  });
  return { request: Object.assign(body, { headers }) as unknown as IncomingMessage, state };
}

function bytes(data: Uint8Array | string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(data)]), {
    headers,
  }) as unknown as IncomingMessage;
}

const LIMIT = 2 * 1024 * 1024;

describe("readBodyWithLimit (#155 items 10 and 12, HTTP part)", () => {
  it("accepts a body of exactly the limit and refuses one byte more (D-96)", async () => {
    const exact = await readBodyWithLimit(bytes(new Uint8Array(LIMIT)), LIMIT);
    expect(exact.ok && exact.bytes.byteLength).toBe(LIMIT);
    const over = await readBodyWithLimit(bytes(new Uint8Array(LIMIT + 1)), LIMIT);
    expect(over).toEqual({ ok: false, status: 413, reason: "body_too_large" });
  });

  it("counts multi-byte characters in bytes, not code units", async () => {
    // 4 x U+010D is 8 bytes in UTF-8 but 4 UTF-16 code units.
    const body = "\u010d".repeat(4);
    expect(await readBodyWithLimit(bytes(body), 7)).toMatchObject({ status: 413 });
    const fits = await readBodyWithLimit(bytes(body), 8);
    expect(fits.ok && fits.bytes.byteLength).toBe(8);
  });

  it("refuses a declared Content-Length over the limit without reading the body", async () => {
    const { request, state } = tracked(1024, 4096, { "content-length": String(LIMIT + 1) });
    const result = await readBodyWithLimit(request, LIMIT);
    expect(result).toEqual({ ok: false, status: 413, reason: "body_too_large" });
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(request.isPaused()).toBe(true);
  });

  it("stops at the limit when Content-Length is missing, without draining the rest", async () => {
    // 4 MiB offered in 64 KiB chunks against a 2 MiB limit.
    const { request, state } = tracked(64 * 1024, 64);
    const result = await readBodyWithLimit(request, LIMIT);
    expect(result).toEqual({ ok: false, status: 413, reason: "body_too_large" });
    // 33 chunks cross the limit; allow a little read-ahead, never the whole 64.
    expect(state.pulled).toBeLessThan(40);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.pulled).toBeLessThan(40);
  });

  it("refuses a declared length that does not match the bytes received", async () => {
    for (const declared of ["9", "11"]) {
      const { request } = tracked(10, 1, { "content-length": declared });
      expect(await readBodyWithLimit(request, LIMIT), declared).toEqual({
        ok: false,
        status: 400,
        reason: "content_length_mismatch",
      });
    }
  });

  it.each(["-1", "1e3", "0x10", "01", "5, 5", " 5", "", "99999999999999999999"])(
    "refuses a malformed Content-Length %j",
    async (value) => {
      const { request } = tracked(5, 1, { "content-length": value });
      expect(await readBodyWithLimit(request, LIMIT)).toEqual({
        ok: false,
        status: 400,
        reason: "content_length_invalid",
      });
    },
  );

  // The one rule a route asks before work it does ahead of the body (F-098).
  it.each<[string | undefined, 400 | 413 | null]>([
    [undefined, null],
    ["5", null],
    [String(LIMIT), null],
    [String(LIMIT + 1), 413],
    ["-1", 400],
    ["01", 400],
    ["abc", 400],
  ])(
    "declaredLengthRefusal(%j) is what readBodyWithLimit refuses unread",
    async (value, expected) => {
      const headers: Record<string, string> =
        value === undefined ? {} : { "content-length": value };
      expect(declaredLengthRefusal(tracked(5, 1, headers).request, LIMIT)).toBe(expected);
      if (expected === null) return;
      const { request, state } = tracked(5, 1, headers);
      expect(await readBodyWithLimit(request, LIMIT)).toMatchObject({
        ok: false,
        status: expected,
      });
      expect(state.pulled).toBeLessThanOrEqual(1);
    },
  );

  it("returns the received bytes untouched: BOM, invalid UTF-8 and NUL survive for the strict check", async () => {
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x00, 0xed, 0xa0, 0x80, 0x7d]);
    const result = await readBodyWithLimit(bytes(raw), LIMIT);
    expect(result.ok && [...result.bytes]).toEqual([...raw]);
  });

  it("returns body_stream_error, not a throw or partial bytes, when the stream fails mid-read", async () => {
    for (const headers of [{}, { "content-length": "4096" }]) {
      let pulls = 0;
      const failing = new Readable({
        read() {
          if (pulls++ === 0) this.push(Buffer.alloc(1024, 0x61));
          else this.destroy(new Error("connection reset"));
        },
      });
      const request = Object.assign(failing, { headers }) as unknown as IncomingMessage;
      expect(await readBodyWithLimit(request, LIMIT)).toEqual({
        ok: false,
        status: 400,
        reason: "body_stream_error",
      });
    }
  });

  it("returns body_stream_error when the client goes away without an error", async () => {
    const gone = new Readable({ read() {} });
    const request = Object.assign(gone, { headers: {} }) as unknown as IncomingMessage;
    const pending = readBodyWithLimit(request, LIMIT);
    gone.push(Buffer.from("{"));
    gone.destroy();
    expect(await pending).toMatchObject({ reason: "body_stream_error" });
  });

  it("refuses a body that was already read instead of returning nothing", async () => {
    const request = bytes("{}");
    expect(await readBodyWithLimit(request, LIMIT)).toMatchObject({ ok: true });
    expect(await readBodyWithLimit(request, LIMIT)).toMatchObject({ reason: "body_stream_error" });
  });

  // Adversarial pass on 74ced6c: two readers both got the bytes.
  it("gives a second, concurrent reader nothing", async () => {
    const request = bytes("abc");
    const [first, second] = await Promise.all([
      readBodyWithLimit(request, LIMIT),
      readBodyWithLimit(request, LIMIT),
    ]);
    expect(first.ok && Buffer.from(first.bytes).toString()).toBe("abc");
    expect(second).toMatchObject({ reason: "body_stream_error" });
  });

  // Adversarial pass on 74ced6c: a request paused before the call never flowed.
  it("reads a request that was paused before the call", async () => {
    const request = bytes("{}");
    request.pause();
    const result = await readBodyWithLimit(request, LIMIT, 1_000);
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe("{}");
  });

  it("stops a slow body at the route's absolute read deadline", async () => {
    const slow = new Readable({ read() {} });
    const request = Object.assign(slow, { headers: {} }) as unknown as IncomingMessage;
    expect(await readBodyWithLimit(request, LIMIT, 20)).toEqual({
      ok: false,
      status: 408,
      reason: "body_timeout",
    });
    expect(slow.isPaused()).toBe(true);
  });

  it("returns an empty body as zero bytes", async () => {
    const empty = Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage;
    const result = await readBodyWithLimit(empty, LIMIT);
    expect(result.ok && result.bytes.byteLength).toBe(0);
  });

  it("rejects a limit or deadline that is not a safe integer", async () => {
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readBodyWithLimit(bytes(""), limit), String(limit)).rejects.toThrow(/maxBytes/u);
    }
    // Adversarial pass on 74ced6c: setTimeout fires at once above 2^31-1.
    for (const timeout of [0, -1, 1.5, Number.NaN, 2_147_483_648, 3_000_000_000]) {
      await expect(readBodyWithLimit(bytes(""), 10, timeout), String(timeout)).rejects.toThrow(
        /timeoutMs/u,
      );
    }
  });
});
