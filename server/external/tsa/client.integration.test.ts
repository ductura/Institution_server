import { createFakeClock } from "@ductura/test-fakes/clock";
import {
  createFakeTsa,
  createTestPki,
  type FakeTsaMode,
  type TestPki,
} from "@ductura/test-fakes/tsa";
import { beforeAll, describe, expect, it } from "vitest";

import {
  anyVerified,
  MAX_RESPONSE_BYTES,
  parseCertificates,
  requestTimeStamp,
  stampWithAll,
  stampWithTsa,
  type TsaClientDeps,
  type TsaConfig,
  type TsaEndpoint,
  type TsaFetch,
  type TrustMaterial,
} from "./index.ts";

const START = "2026-11-27T03:00:00.000Z";
const DIGEST = new Uint8Array(32).fill(7);
const ENDPOINT: TsaEndpoint = {
  id: "lazni-tsa",
  url: "https://tsa.ductura.invalid/",
  timeoutMs: 20,
};
const CONFIG: TsaConfig = {
  format: "ductura-tsa-v1",
  tsas: [
    { id: "prvi", url: "https://prvi.ductura.invalid/", timeoutMs: 20 },
    { id: "drugi", url: "https://drugi.ductura.invalid/", timeoutMs: 20 },
  ],
  maxAttempts: 3,
  initialBackoffMs: 1000,
  clockSkewMs: 60_000,
};

let pki: TestPki;
let trust: TrustMaterial;

beforeAll(async () => {
  pki = await createTestPki(new Date(START));
  trust = { anchors: parseCertificates([pki.root.der]) ?? [] };
});

function depsFor(fetch: TsaFetch, sleeps: number[] = []): TsaClientDeps {
  const clock = createFakeClock(START);
  return { fetch, now: () => clock.now(), sleep: async (ms) => void sleeps.push(ms) };
}

async function fake(mode: FakeTsaMode) {
  return createFakeTsa({ mode, pki, clock: createFakeClock(START) });
}

describe("requestTimeStamp transport", () => {
  it("POSTs application/timestamp-query to the configured URL, without following redirects", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const tsa = await fake("valid");
    const result = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(async (url, init) => {
        seen.push({ url, init });
        return tsa.fetch(url, init);
      }),
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(ENDPOINT.url);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.redirect).toBe("error");
    expect(seen[0]?.init.headers).toEqual({
      "content-type": "application/timestamp-query",
      accept: "application/timestamp-reply",
    });
  });

  it("a network error is TSA_UNAVAILABLE", async () => {
    const result = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(!result.ok && result.error.code).toBe("TSA_UNAVAILABLE");
  });

  it.each([201, 301, 400, 500, 503])("HTTP %i is TSA_HTTP_STATUS", async (status) => {
    const result = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(async () => new Response(status === 301 ? null : "x", { status })),
    );
    expect(!result.ok && result.error.code).toBe("TSA_HTTP_STATUS");
  });

  it("a body over the limit is TSA_MALFORMED and is not read to the end", async () => {
    const declared = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(
        async () =>
          new Response(new Uint8Array(16), {
            status: 200,
            headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
          }),
      ),
    );
    expect(!declared.ok && declared.error.code).toBe("TSA_MALFORMED");
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const streamed = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(async () => new Response(endless, { status: 200 })),
    );
    expect(!streamed.ok && streamed.error.code).toBe("TSA_MALFORMED");
    expect(pulled).toBeLessThan(10);
  });

  it("an empty 200 body is TSA_MALFORMED", async () => {
    const result = await requestTimeStamp(
      ENDPOINT,
      DIGEST,
      trust,
      60_000,
      depsFor(async () => new Response(null, { status: 200 })),
    );
    expect(!result.ok && result.error.code).toBe("TSA_MALFORMED");
  });

  it("a wrong digest never reaches the network", async () => {
    let calls = 0;
    const result = await requestTimeStamp(
      ENDPOINT,
      new Uint8Array(31),
      trust,
      60_000,
      depsFor(async () => {
        calls++;
        return new Response(null);
      }),
    );
    expect(!result.ok && result.error.code).toBe("TSA_DIGEST_INVALID");
    expect(calls).toBe(0);
  });
});

describe("stampWithTsa attempts (O-4 (a))", () => {
  it("retries up to maxAttempts with doubling backoff and a new nonce each time", async () => {
    const tsa = await fake("rejection");
    const sleeps: number[] = [];
    const outcome = await stampWithTsa(ENDPOINT, DIGEST, trust, CONFIG, depsFor(tsa.fetch, sleeps));
    expect(outcome.attempts).toBe(3);
    expect(!outcome.result.ok && outcome.result.error.code).toBe("TSA_REJECTED");
    expect(sleeps).toEqual([1000, 2000]);
    const bodies = new Set(tsa.requests.map((r) => Buffer.from(r.der).toString("hex")));
    expect(bodies.size).toBe(3);
  });

  it("stops at the first verified time stamp", async () => {
    const good = await fake("valid");
    let calls = 0;
    const outcome = await stampWithTsa(
      ENDPOINT,
      DIGEST,
      trust,
      CONFIG,
      depsFor(async (url, init) => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return good.fetch(url, init);
      }),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.result.ok).toBe(true);
  });

  it("a timeout of every attempt ends as TSA_TIMEOUT, not as an exception", async () => {
    const tsa = await fake("timeout");
    const outcome = await stampWithTsa(ENDPOINT, DIGEST, trust, CONFIG, depsFor(tsa.fetch));
    expect(outcome).toMatchObject({
      attempts: 3,
      result: { ok: false, error: { code: "TSA_TIMEOUT" } },
    });
  });

  it("missing anchors or a wrong digest are not retried and call nobody", async () => {
    const tsa = await fake("valid");
    const noTrust = await stampWithTsa(ENDPOINT, DIGEST, undefined, CONFIG, depsFor(tsa.fetch));
    const emptyTrust = await stampWithTsa(
      ENDPOINT,
      DIGEST,
      { anchors: [] },
      CONFIG,
      depsFor(tsa.fetch),
    );
    const badDigest = await stampWithTsa(
      ENDPOINT,
      new Uint8Array(33),
      trust,
      CONFIG,
      depsFor(tsa.fetch),
    );
    expect(noTrust).toMatchObject({
      attempts: 0,
      result: { error: { code: "TSA_ANCHORS_INVALID" } },
    });
    expect(emptyTrust).toMatchObject({
      attempts: 0,
      result: { error: { code: "TSA_ANCHORS_INVALID" } },
    });
    expect(badDigest).toMatchObject({
      attempts: 0,
      result: { error: { code: "TSA_DIGEST_INVALID" } },
    });
    expect(tsa.requests).toHaveLength(0);
  });
});

describe("stampWithAll (D-72: two independent TSAs, O-2 (c): no fallback)", () => {
  async function byUrl(modes: Readonly<Record<string, FakeTsaMode>>): Promise<TsaFetch> {
    const fakes = new Map<string, Awaited<ReturnType<typeof fake>>>();
    for (const [url, mode] of Object.entries(modes)) fakes.set(url, await fake(mode));
    return async (url, init) => {
      const target = fakes.get(url);
      if (!target) throw new Error(`unexpected URL ${url}`);
      return target.fetch(url, init);
    };
  }
  const trustBoth = (): Record<string, TrustMaterial> => ({ prvi: trust, drugi: trust });

  it("one valid, one rejected: the day succeeds and both outcomes are kept in order", async () => {
    const fetch = await byUrl({
      "https://prvi.ductura.invalid/": "rejection",
      "https://drugi.ductura.invalid/": "valid",
    });
    const outcomes = await stampWithAll(CONFIG, DIGEST, trustBoth(), depsFor(fetch));
    expect(outcomes.map((o) => [o.tsaId, o.result.ok])).toEqual([
      ["prvi", false],
      ["drugi", true],
    ]);
    expect(anyVerified(outcomes)).toBe(true);
  });

  it("both fail: no exception, two reason codes, and no verified stamp", async () => {
    const fetch = await byUrl({
      "https://prvi.ductura.invalid/": "malformed-der",
      "https://drugi.ductura.invalid/": "timeout",
    });
    const outcomes = await stampWithAll(CONFIG, DIGEST, trustBoth(), depsFor(fetch));
    expect(outcomes.map((o) => (o.result.ok ? "OK" : o.result.error.code))).toEqual([
      "TSA_MALFORMED",
      "TSA_TIMEOUT",
    ]);
    expect(anyVerified(outcomes)).toBe(false);
  });

  it("trust is looked up by own key only; a TSA without anchors fails alone", async () => {
    const fetch = await byUrl({
      "https://prvi.ductura.invalid/": "valid",
      "https://drugi.ductura.invalid/": "valid",
    });
    const trustByTsa = Object.assign(
      Object.create({ drugi: trust }) as Record<string, TrustMaterial>,
      { prvi: trust },
    );
    const outcomes = await stampWithAll(CONFIG, DIGEST, trustByTsa, depsFor(fetch));
    expect(outcomes.map((o) => (o.result.ok ? "OK" : o.result.error.code))).toEqual([
      "OK",
      "TSA_ANCHORS_INVALID",
    ]);
  });
});
