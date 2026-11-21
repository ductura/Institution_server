import { readFileSync } from "node:fs";

import { fc } from "@fast-check/vitest";
import { expect, it } from "vitest";

import {
  canonicalizeJcs,
  MAX_EVIDENCE_SEGMENT_BYTES,
  verifyCanonicalEvidencePayloadV2,
  verifyEvidenceChainV2,
  type EvidenceSegmentV2,
} from "../../domain/index.ts";

// Independent known answers for two linked segments with invented data.
const { chain } = JSON.parse(
  readFileSync(
    new URL("../../domain/forensics/golden-vectors/evidence-v2.json", import.meta.url),
    "latin1",
  ),
) as {
  chain: {
    segments: { canonicalUtf8Hex: string; segmentHash: string; segment: EvidenceSegmentV2 }[];
  };
};
const [first, second] = chain.segments;
const FIRST = Buffer.from(first!.canonicalUtf8Hex, "hex");
const SECOND = Buffer.from(second!.canonicalUtf8Hex, "hex");
const HEAD = { segmentCount: 2, segmentHash: second!.segmentHash };
const ENCODER = new TextEncoder();
const FUZZ = {
  seed: 1506,
  numRuns: 100,
  interruptAfterTimeLimit: 3_000,
  markInterruptAsFailure: true,
};
const TEST_OPTIONS = { timeout: 5_000 };

async function expectRefusal(bytes: Uint8Array, reason: "invalid" | "too_large") {
  // B-8 uses the single-segment verifier. B-12 verifies the stored chain before replay.
  expect(await verifyCanonicalEvidencePayloadV2(bytes)).toEqual({ ok: false, reason });
  expect(await verifyEvidenceChainV2([FIRST, bytes], HEAD)).toEqual({
    ok: false,
    reason: reason === "invalid" ? "invalid_segment" : reason,
    index: 1,
  });
}

it("accepts both original segments and their recorded chain", async () => {
  expect(await verifyCanonicalEvidencePayloadV2(SECOND)).toMatchObject({
    ok: true,
    sha256: HEAD.segmentHash,
    byteLength: SECOND.length,
  });
  expect(await verifyEvidenceChainV2([FIRST, SECOND], HEAD)).toEqual({
    ok: true,
    head: HEAD,
    discontinuities: [],
  });
});

it("rejects arbitrary bytes without a parser exception", TEST_OPTIONS, async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 128 }), (bytes) => expectRefusal(bytes, "invalid")),
    FUZZ,
  );
});

it("rejects malformed steps inside a canonical segment", TEST_OPTIONS, async () => {
  const { events, ...segment } = second!.segment;
  const invalidStep = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string());
  await fc.assert(
    fc.asyncProperty(invalidStep, async (step) => {
      const text = canonicalizeJcs({
        ...segment,
        events: [{ ...events[0]!, steps: [step] }, ...events.slice(1)],
      });
      await expectRefusal(ENCODER.encode(text), "invalid");
    }),
    FUZZ,
  );
});

it("rejects truncated segments without a parser exception", TEST_OPTIONS, async () => {
  await fc.assert(
    fc.asyncProperty(fc.nat(SECOND.length - 1), (end) =>
      expectRefusal(SECOND.subarray(0, end), "invalid"),
    ),
    { ...FUZZ, examples: [[0], [SECOND.length - 1]] },
  );
});

it("returns the size refusal for segments above the byte limit", TEST_OPTIONS, async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 256 }), async (extraBytes) => {
      const bytes = new Uint8Array(MAX_EVIDENCE_SEGMENT_BYTES + extraBytes).fill(0x20);
      bytes.set(SECOND);
      await expectRefusal(bytes, "too_large");
    }),
    { ...FUZZ, numRuns: 8, examples: [[1]] },
  );
});
