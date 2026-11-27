import { createFakeClock } from "@ductura/test-fakes/clock";
import { createFakeTsa, createTestPki } from "@ductura/test-fakes/tsa";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildTimeStampRequest,
  newNonce,
  parseCertificates,
  type TimeStampExpectation,
  type TrustMaterial,
  verifyTimeStampResponse,
} from "./index.ts";

// ISTR-2 §7: "promjena jednog bajta ulaza iz §2 ruši provjeru". One valid
// response from the fake TSA, then single-byte changes of the digest the
// caller expects and of the response itself.
const START = "2026-11-27T03:00:00.000Z";
const DIGEST = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);

let der: Uint8Array;
let expectation: TimeStampExpectation;
let trust: TrustMaterial;

beforeAll(async () => {
  const clock = createFakeClock(START);
  const pki = await createTestPki(new Date(START));
  const tsa = await createFakeTsa({ mode: "valid", pki, clock });
  const nonce = newNonce();
  const request = buildTimeStampRequest(DIGEST, nonce);
  if (!request.ok) throw new Error(request.error.code);
  const response = await tsa.fetch("https://tsa.ductura.invalid/", {
    method: "POST",
    body: request.value,
  });
  der = new Uint8Array(await response.arrayBuffer());
  expectation = {
    digest: DIGEST,
    nonce,
    notBefore: new Date(Date.parse(START) - 60_000),
    notAfter: new Date(Date.parse(START) + 60_000),
  };
  trust = { anchors: parseCertificates([pki.root.der]) ?? [] };
  const baseline = await verifyTimeStampResponse(der, expectation, trust);
  if (!baseline.ok) throw new Error(`baseline must verify: ${baseline.error.code}`);
});

const flip = (bytes: Uint8Array, index: number, mask: number): Uint8Array => {
  const copy = bytes.slice();
  copy[index % copy.length] = (copy[index % copy.length] ?? 0) ^ mask;
  return copy;
};

describe("one changed byte breaks the check", () => {
  it("of the digest: always TSA_IMPRINT_MISMATCH", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(31), fc.integer({ min: 1, max: 255 }), async (index, mask) => {
        const result = await verifyTimeStampResponse(
          der,
          { ...expectation, digest: flip(DIGEST, index, mask) },
          trust,
        );
        expect(!result.ok && result.error.code).toBe("TSA_IMPRINT_MISMATCH");
      }),
      { numRuns: 100 },
    );
  });

  it("of the response: never throws, and never verifies with other attested content", async () => {
    // Some bytes are outside the signature by design of CMS and RFC 3161 (the
    // PKIStatus, a BER length the parser tolerates). Changing them may still
    // verify, but never with another time, serial, policy or signer path.
    const baseline = await verifyTimeStampResponse(der, expectation, trust);
    if (!baseline.ok) throw new Error(baseline.error.code);
    const attested = (v: typeof baseline.value) => ({
      genTime: v.genTime.toISOString(),
      serialNumber: v.serialNumber,
      policy: v.policy,
      path: v.certificatePath.map((c) => Buffer.from(c).toString("hex")),
    });
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.integer({ min: 1, max: 255 }), async (index, mask) => {
        const result = await verifyTimeStampResponse(flip(der, index, mask), expectation, trust);
        if (result.ok) expect(attested(result.value)).toEqual(attested(baseline.value));
        else refused++;
      }),
      { numRuns: 300 },
    );
    expect(refused).toBeGreaterThan(250);
  });

  it("of the nonce: always TSA_NONCE_MISMATCH", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 15 }),
        fc.integer({ min: 1, max: 255 }),
        async (index, mask) => {
          const nonce = flip(expectation.nonce, index, mask);
          const result = await verifyTimeStampResponse(der, { ...expectation, nonce }, trust);
          expect(!result.ok && result.error.code).toBe("TSA_NONCE_MISMATCH");
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("arbitrary input", () => {
  it("random bytes and truncations never verify and never throw", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        expect((await verifyTimeStampResponse(bytes, expectation, trust)).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
    await fc.assert(
      fc.asyncProperty(fc.nat(), async (cut) => {
        const result = await verifyTimeStampResponse(
          der.subarray(0, cut % der.length),
          expectation,
          trust,
        );
        expect(!result.ok && result.error.code).toBe("TSA_MALFORMED");
      }),
      { numRuns: 100 },
    );
  });

  it("returns its own copy of exactly the response bytes, also for a pooled Buffer", async () => {
    const pooled = Buffer.from(Buffer.from(der).toString("hex"), "hex");
    expect(pooled.buffer.byteLength).toBeGreaterThan(der.byteLength);
    const result = await verifyTimeStampResponse(pooled, expectation, trust);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.der.buffer.byteLength).toBe(der.byteLength);
    expect(Buffer.from(result.value.der)).toEqual(Buffer.from(der));
  });

  it("trailing bytes after the DER are refused", async () => {
    const extended = new Uint8Array([...der, 0x00]);
    const result = await verifyTimeStampResponse(extended, expectation, trust);
    expect(!result.ok && result.error.code).toBe("TSA_MALFORMED");
  });

  it("genTime outside the window is TSA_GEN_TIME on both sides", async () => {
    const at = Date.parse(START);
    const early = await verifyTimeStampResponse(
      der,
      { ...expectation, notBefore: new Date(at + 1) },
      trust,
    );
    const late = await verifyTimeStampResponse(
      der,
      { ...expectation, notAfter: new Date(at - 1) },
      trust,
    );
    expect([early, late].map((r) => !r.ok && r.error.code)).toEqual([
      "TSA_GEN_TIME",
      "TSA_GEN_TIME",
    ]);
  });

  it("no anchors is TSA_ANCHORS_INVALID, a wrong expected digest TSA_DIGEST_INVALID", async () => {
    const noAnchors = await verifyTimeStampResponse(der, expectation, { anchors: [] });
    const shortDigest = await verifyTimeStampResponse(
      der,
      { ...expectation, digest: DIGEST.subarray(1) },
      trust,
    );
    expect(!noAnchors.ok && noAnchors.error.code).toBe("TSA_ANCHORS_INVALID");
    expect(!shortDigest.ok && shortDigest.error.code).toBe("TSA_DIGEST_INVALID");
  });
});
