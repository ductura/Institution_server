import { describe, expect, it } from "vitest";

import { EDIT_STEP_FORMAT_V1, EDIT_STEP_FORMAT_V3 } from "../document/index.ts";

import { verifyCanonicalEvidencePayloadV2 } from "./evidence-chain-v2.ts";
import {
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  EVIDENCE_TRANSACTION_FORMATS,
  isEvidenceSegment,
} from "./evidence-segment-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "./jcs.ts";

/**
 * SRV-7F (docs/contracts/document-schema-v3.md §5, §7): a segment may name
 * `ductus-edit-steps-v3`, and then every step is read with the v3 parser,
 * atoms included. Whether a work takes that format is the server's
 * acceptance's to decide (server/evidence/service.ts), never this check's.
 * Every value is invented.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const SRC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const footnote = { type: "footnote", text: "Izmišljeno objašnjenje." };
const citationV3 = { type: "citation", sourceId: SRC, locator: "str. 12", via: "Izmišljeni, 1973" };

function segment(format: string, content: JcsJsonValue[]): Record<string, JcsJsonValue> {
  return {
    evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
    canonicalization: EVIDENCE_CANONICALIZATION_V2,
    hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
    documentId: "doc-7f",
    sessionId: "session-7f",
    segmentId: "segment-7f",
    sequenceFrom: 1,
    sequenceTo: 1,
    observedStartedAt: "2026-11-20T10:00:00.000Z",
    observedEndedAt: "2026-11-20T10:01:00.000Z",
    initialDocumentHash: A,
    finalDocumentHash: B,
    predecessorSegmentHash: null,
    events: [
      {
        sequence: 1,
        source: "editor",
        steps: [{ stepType: "replace", from: 1, to: 1, slice: { content } }],
        beforeDocumentHash: A,
        afterDocumentHash: B,
      },
    ],
    captureContext: { editorModel: "prosemirror", transactionFormat: format },
    evidenceProfileId: "standard-v1",
  };
}

const text = { type: "text", text: "A" };

describe("segment step format v3 (SRV-7F)", () => {
  it("names exactly the formats v1 and v3", () => {
    expect(EVIDENCE_TRANSACTION_FORMATS).toEqual([EDIT_STEP_FORMAT_V1, EDIT_STEP_FORMAT_V3]);
  });

  it.each([
    ["text", [text]],
    ["a footnote", [footnote]],
    ["a citation with via", [citationV3]],
  ])("takes v3 steps with %s, byte for byte", async (_, content) => {
    const value = segment(EDIT_STEP_FORMAT_V3, content);
    expect(isEvidenceSegment(value)).toBe(true);
    const bytes = new TextEncoder().encode(canonicalizeJcs(value));
    const verified = await verifyCanonicalEvidencePayloadV2(bytes);
    expect(verified.ok && verified.segment.captureContext.transactionFormat).toBe(
      EDIT_STEP_FORMAT_V3,
    );
  });

  it.each([
    ["a footnote under v1", EDIT_STEP_FORMAT_V1, [footnote]],
    ["a citation with via under v1", EDIT_STEP_FORMAT_V1, [citationV3]],
    ["a footnote with marks under v3", EDIT_STEP_FORMAT_V3, [{ ...footnote, marks: [] }]],
    ["an empty footnote under v3", EDIT_STEP_FORMAT_V3, [{ ...footnote, text: "" }]],
    [
      "a cross reference without target under v3",
      EDIT_STEP_FORMAT_V3,
      [{ type: "crossReference" }],
    ],
    ["text under format v2", "ductus-edit-steps-v2", [text]],
    ["text under a format in capitals", EDIT_STEP_FORMAT_V3.toUpperCase(), [text]],
    ["text under format v4", "ductus-edit-steps-v4", [text]],
  ])("refuses %s", (_, format, content) => {
    expect(isEvidenceSegment(segment(format, content as JcsJsonValue[]))).toBe(false);
  });
});
