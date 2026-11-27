import { createFakeClock } from "@ductura/test-fakes/clock";
import {
  createFakeTsa,
  createTestPki,
  FAKE_TSA_MODES,
  type FakeTsaMode,
  type TestPki,
} from "@ductura/test-fakes/tsa";
import { beforeAll, describe, expect, it } from "vitest";

import {
  parseCertificates,
  requestTimeStamp,
  type TsaClientDeps,
  type TsaEndpoint,
  type TsaErrorCode,
  type TrustMaterial,
} from "./index.ts";

// ISTR-2 §7 "Golden odgovori lažnog TSA-a iz koraka 2 daju točno očekivani kod
// razloga": every mode of the fake TSA, through the real client and verifier.
const EXPECTED: Readonly<Record<FakeTsaMode, TsaErrorCode | "OK">> = {
  valid: "OK",
  rejection: "TSA_REJECTED",
  "wrong-imprint": "TSA_IMPRINT_MISMATCH",
  "wrong-nonce": "TSA_NONCE_MISMATCH",
  "expired-certificate": "TSA_CERTIFICATE_EXPIRED",
  "wrong-eku": "TSA_EKU",
  "malformed-der": "TSA_MALFORMED",
  timeout: "TSA_TIMEOUT",
  "untrusted-root": "TSA_CHAIN",
  "wrong-ess-cert-id": "TSA_ESS_CERT_ID",
  "stale-gen-time": "TSA_GEN_TIME",
};

const START = "2026-11-27T03:00:00.000Z";
const ENDPOINT: TsaEndpoint = {
  id: "lazni-tsa",
  url: "https://tsa.ductura.invalid/",
  timeoutMs: 20,
};
const digestOf = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

let pki: TestPki;
let trust: TrustMaterial;

beforeAll(async () => {
  pki = await createTestPki(new Date(START));
  const anchors = parseCertificates([pki.root.der]);
  if (anchors === null) throw new Error("test anchor did not parse");
  trust = { anchors };
});

async function run(mode: FakeTsaMode) {
  const clock = createFakeClock(START);
  const tsa = await createFakeTsa({ mode, pki, clock });
  const deps: TsaClientDeps = {
    fetch: (url, init) => tsa.fetch(url, init),
    now: () => clock.now(),
    sleep: async () => {},
  };
  const digest = await digestOf(`izmišljena bilješka ${mode}`);
  const result = await requestTimeStamp(ENDPOINT, digest, trust, 120_000, deps);
  return { tsa, digest, result };
}

describe("golden cases of the fake TSA", () => {
  it("covers every mode of the fake", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...FAKE_TSA_MODES].sort());
  });

  for (const mode of FAKE_TSA_MODES) {
    it(`${mode} → ${EXPECTED[mode]}`, async () => {
      const { tsa, result } = await run(mode);
      expect(result.ok ? "OK" : result.error.code).toBe(EXPECTED[mode]);
      if (!result.ok) expect(result.error.messageKey).toMatch(/^tsa\.[a-z_]+$/u);
      // The fake only ever received one well-formed TimeStampReq with a 32-byte imprint.
      expect(tsa.requests).toHaveLength(1);
      expect(tsa.requests.every((r) => r.valid)).toBe(true);
      expect(tsa.requests[0]?.contentType).toBe("application/timestamp-query");
    });
  }

  it("valid: returns the exact bytes, genTime and the path up to the pinned root", async () => {
    const { result } = await run("valid");
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.genTime.toISOString()).toBe(START);
    expect(result.value.policy).toBe("2.999.1");
    expect(result.value.serialNumber).toMatch(/^[0-9a-f]+$/u);
    expect(result.value.certificatePath.map((c) => Buffer.from(c).toString("hex"))).toEqual(
      [pki.tsa.der, pki.intermediate.der, pki.root.der].map((c) => Buffer.from(c).toString("hex")),
    );
  });

  it("valid: the request carries only the digest, never the note text", async () => {
    const { tsa, digest } = await run("valid");
    const body = Buffer.from(tsa.requests[0]?.der ?? new Uint8Array());
    expect(body.includes(Buffer.from(digest))).toBe(true);
    expect(body.includes(Buffer.from("izmišljena"))).toBe(false);
  });

  it("valid response, but trusting a different root, fails the chain", async () => {
    const clock = createFakeClock(START);
    const tsa = await createFakeTsa({ mode: "valid", pki, clock });
    const foreign = parseCertificates([pki.foreignRoot.der]) ?? [];
    const result = await requestTimeStamp(
      ENDPOINT,
      await digestOf("x"),
      { anchors: foreign },
      120_000,
      {
        fetch: (url, init) => tsa.fetch(url, init),
        now: () => clock.now(),
        sleep: async () => {},
      },
    );
    expect(result.ok ? "OK" : result.error.code).toBe("TSA_CHAIN");
  });
});
