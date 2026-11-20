import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EDIT_STEP_FORMAT_V1, EDIT_STEP_FORMAT_V3, parseEditSteps } from "../document/index.ts";

import {
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  EVIDENCE_SEGMENT_SCHEMA_V3,
  EVIDENCE_SEGMENT_SCHEMA_V4,
  EVIDENCE_TRANSACTION_FORMAT_V4,
  EVIDENCE_TRANSACTION_FORMATS,
  evidenceTransactionFormatOfWork,
  isEvidenceSegment,
} from "./evidence-segment-v2.ts";
import type { JcsJsonValue } from "./jcs.ts";

/**
 * SRV-10E (docs/contracts/document-schema-v4.md §9, §10): a segment may name
 * `ductus-edit-steps-v4`, and then its steps are read by the document's own
 * parser of that format, never by a second reader in forensics. Which format a
 * work takes is the work's version of revision 0, through
 * `evidenceTransactionFormatOfWork`; the acceptance (server/evidence/service.ts)
 * applies it. Every value is invented.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const V4 = EVIDENCE_TRANSACTION_FORMAT_V4;

function segment(
  format: string,
  steps: JcsJsonValue,
  evidenceSchema: string = EVIDENCE_SEGMENT_SCHEMA_V2,
): Record<string, JcsJsonValue> {
  return {
    evidenceSchema,
    canonicalization: EVIDENCE_CANONICALIZATION_V2,
    hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
    documentId: "doc-10e",
    sessionId: "session-10e",
    segmentId: "segment-10e",
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
        steps,
        beforeDocumentHash: A,
        afterDocumentHash: B,
      },
    ],
    captureContext: { editorModel: "prosemirror", transactionFormat: format },
    evidenceProfileId: "standard-v1",
  };
}

const replace = (content: JcsJsonValue[]): JcsJsonValue => ({
  stepType: "replace",
  from: 1,
  to: 1,
  slice: { content },
});

// Steps of each kind v4 writes (§9): text, a v3 atom, v4 marks and atoms, a
// block atom, a cover. Whether each is a valid v4 step is the parser's answer.
const CANDIDATES: [string, JcsJsonValue][] = [
  ["text", [replace([{ type: "text", text: "A" }])]],
  ["a footnote", [replace([{ type: "footnote", text: "Izmišljeno objašnjenje." }])]],
  [
    "text with a highlight",
    [replace([{ type: "text", text: "A", marks: [{ type: "highlight", color: "yellow" }] }])],
  ],
  ["an inline formula", [replace([{ type: "inlineFormula", tex: "x^2" }])]],
  ["a page break", [replace([{ type: "pageBreak", id: null }])]],
  ["a cover without the old one", [{ stepType: "coverSet", cover: { title: "Izmišljeni rad" } }]],
  ["a cover removed", [{ stepType: "coverSet" }]],
  ["an addMark with paste", [{ stepType: "addMark", from: 1, to: 2, mark: { type: "paste" } }]],
  ["no step", []],
  ["not an array", { stepType: "replace" }],
];

describe("segment step format v4 (SRV-10E)", () => {
  it("names v4 after v1 and v3", () => {
    expect(EVIDENCE_TRANSACTION_FORMATS).toEqual([EDIT_STEP_FORMAT_V1, EDIT_STEP_FORMAT_V3, V4]);
    expect(V4).toBe("ductus-edit-steps-v4");
  });

  it.each(CANDIDATES)(
    "takes %s under v4 exactly when the document's v4 parser takes it",
    (_, steps) => {
      const parsed = parseEditSteps(V4, steps).ok;
      for (const schema of [
        EVIDENCE_SEGMENT_SCHEMA_V2,
        EVIDENCE_SEGMENT_SCHEMA_V3,
        EVIDENCE_SEGMENT_SCHEMA_V4,
      ]) {
        expect(isEvidenceSegment(segment(V4, steps, schema))).toBe(parsed);
      }
    },
  );

  it("follows the v4 parser on any steps, never a reader of its own", () => {
    const steps = fc.oneof(
      fc.constantFrom(...CANDIDATES.map(([, value]) => value)),
      fc.array(fc.jsonValue({ maxDepth: 4 }), { maxLength: 3 }),
    );
    fc.assert(
      fc.property(steps, (value) => {
        const input = value as JcsJsonValue;
        expect(isEvidenceSegment(segment(V4, input))).toBe(parseEditSteps(V4, input).ok);
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    ["the format in capitals", V4.toUpperCase()],
    ["format v5", "ductus-edit-steps-v5"],
    ["the format with a space", `${V4} `],
  ])("refuses text under %s", (_, format) => {
    expect(isEvidenceSegment(segment(format, [replace([{ type: "text", text: "A" }])]))).toBe(
      false,
    );
  });
});

describe("evidenceTransactionFormatOfWork (SRV-10E, v4 §9 t. 9)", () => {
  it.each([
    [1, EDIT_STEP_FORMAT_V1],
    [2, EDIT_STEP_FORMAT_V1],
    [3, EDIT_STEP_FORMAT_V3],
    [4, V4],
  ])("gives a work of document v%s its one format", (version, format) => {
    expect(evidenceTransactionFormatOfWork(version)).toBe(format);
  });

  it.each([0, 5, -1, 3.5, Number.NaN, "4", "3", 4n, null, undefined, {}, [4]])(
    "gives no format to %o",
    (version) => {
      expect(evidenceTransactionFormatOfWork(version)).toBeNull();
    },
  );

  it("gives each format to works of one version only, v1 to v1 and v2", () => {
    const owners = (format: string) =>
      [1, 2, 3, 4].filter((v) => evidenceTransactionFormatOfWork(v) === format);
    expect(owners(EDIT_STEP_FORMAT_V1)).toEqual([1, 2]);
    expect(owners(EDIT_STEP_FORMAT_V3)).toEqual([3]);
    expect(owners(V4)).toEqual([4]);
  });
});
