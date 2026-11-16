// Ported from Ductus src/application/ports/evidence-ingest.test.ts at d52a92c3
// (the cases of isEvidenceSegmentDescriptorV2), for DAN-815.
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  MAX_EVIDENCE_PROFILE_ID_LENGTH,
  MAX_EVIDENCE_SEGMENT_BYTES,
} from "../forensics/index.ts";
import { loadGoldenVectors } from "../forensics/golden-vectors/index.ts";

import { type EvidenceSegmentDescriptorV2, isEvidenceSegmentDescriptorV2 } from "./index.ts";

function valid(): EvidenceSegmentDescriptorV2 {
  return {
    evidencePackageId: "evidence-1",
    documentId: "doc-1",
    sessionId: "session-1",
    segmentId: "segment-1",
    evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
    canonicalization: EVIDENCE_CANONICALIZATION_V2,
    hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
    evidenceProfileId: "standard-v1",
    sequenceFrom: 1,
    sequenceTo: 1,
    eventCount: 1,
    observedStartedAt: "2026-10-03T06:00:00.000Z",
    observedEndedAt: "2026-10-03T06:01:00.000Z",
    segmentHash: "a".repeat(64),
    predecessorSegmentHash: null,
    payloadBytes: 48,
  };
}
const check = (change: Record<string, unknown>) =>
  isEvidenceSegmentDescriptorV2({ ...valid(), ...change });

describe("isEvidenceSegmentDescriptorV2", () => {
  it("accepts a coherent descriptor and a predecessor hash", () => {
    expect(check({})).toBe(true);
    expect(check({ predecessorSegmentHash: "b".repeat(64) })).toBe(true);
  });

  it("fails closed on chronology, range, hash shape and unknown fields", () => {
    expect(
      check({
        observedStartedAt: "2026-10-03T06:02:00.000Z",
        observedEndedAt: "2026-10-03T06:01:00.000Z",
      }),
    ).toBe(false);
    expect(check({ observedStartedAt: "2026-10-03T06:00:30.000Z" })).toBe(false);
    expect(check({ sequenceTo: 2, eventCount: 1 })).toBe(false);
    expect(check({ sequenceFrom: 0, sequenceTo: 0 })).toBe(false);
    expect(check({ segmentHash: "sha256:not-a-wire-hash" })).toBe(false);
    expect(check({ segmentHash: "A".repeat(64) })).toBe(false);
    expect(check({ predecessorSegmentHash: "b".repeat(63) })).toBe(false);
    expect(check({ canonicalization: "none" })).toBe(false);
    expect(check({ hashAlgorithm: "sha-512" })).toBe(false);
    expect(check({ institutionId: "x" })).toBe(false);
    expect(check({ documentId: " " })).toBe(false);
    expect(check({ sessionId: "s".repeat(257) })).toBe(false);
    expect(check({ segmentId: "" })).toBe(false);
    expect(check({ observedEndedAt: "2026-10-03T06:01:30.000Z" })).toBe(false);
    expect(check({ segmentHash: ["a".repeat(64)] })).toBe(false);
    expect(isEvidenceSegmentDescriptorV2(Object.assign(new (class Descriptor {})(), valid()))).toBe(
      false,
    );
    expect(isEvidenceSegmentDescriptorV2(null)).toBe(false);
    expect(isEvidenceSegmentDescriptorV2([])).toBe(false);
  });

  it("counts the events of a range exactly, up to the largest safe integer", () => {
    const { accepted, rejected } = loadGoldenVectors().sequenceRanges;
    const withRange = (r: { sequenceFrom: number; sequenceTo: number; eventCount: number }) =>
      check({ sequenceFrom: r.sequenceFrom, sequenceTo: r.sequenceTo, eventCount: r.eventCount });
    expect(accepted.length).toBeGreaterThanOrEqual(6);
    for (const range of accepted) expect(withRange(range), range.name).toBe(true);
    for (const range of rejected) expect(withRange(range), range.name).toBe(false);
  });

  it("bounds the declared size on its own", () => {
    expect(check({ payloadBytes: MAX_EVIDENCE_SEGMENT_BYTES })).toBe(true);
    expect(check({ payloadBytes: MAX_EVIDENCE_SEGMENT_BYTES + 1 })).toBe(false);
    expect(check({ payloadBytes: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(check({ payloadBytes: 0 })).toBe(false);
    expect(check({ payloadBytes: 1.5 })).toBe(false);
  });

  it("bounds the evidence profile id like the segment and the receipt do", () => {
    expect(check({ evidenceProfileId: "p".repeat(MAX_EVIDENCE_PROFILE_ID_LENGTH) })).toBe(true);
    expect(check({ evidenceProfileId: "p".repeat(MAX_EVIDENCE_PROFILE_ID_LENGTH + 1) })).toBe(
      false,
    );
  });

  it("takes only package ids that are safe as one object key segment", () => {
    for (const id of ["a", "evidence-1", "a_b-c", "a".repeat(128)]) {
      expect(check({ evidencePackageId: id })).toBe(true);
    }
    for (const id of ["", "Evidence-1", "-a", "a/b", "..", "a.b", "a\n", "a".repeat(129)]) {
      expect(check({ evidencePackageId: id })).toBe(false);
    }
  });

  it.each(["ductus-evidence-segment-v2", "ductus-evidence-segment-v3"])("accepts %s", (schema) => {
    expect(check({ evidenceSchema: schema })).toBe(true);
  });

  it.each(["ductus-evidence-segment-v1", "ductus-evidence-segment-v4", "", null])(
    "refuses schema %s",
    (schema) => {
      expect(check({ evidenceSchema: schema })).toBe(false);
    },
  );
});
