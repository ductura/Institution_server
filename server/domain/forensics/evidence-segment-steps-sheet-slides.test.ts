import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EDIT_STEP_FORMAT_V1 } from "../document/index.ts";
import { SHEET_STEP_FORMAT_V1 } from "../sheet/index.ts";
import { SLIDE_STEP_FORMAT_V1 } from "../slides/index.ts";

import { verifyCanonicalEvidencePayloadV2 } from "./evidence-chain-v2.ts";
import {
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  EVIDENCE_SEGMENT_SCHEMA_V3,
  EVIDENCE_SEGMENT_TRANSACTION_FORMATS,
  EVIDENCE_SHEET_TRANSACTION_FORMAT_V1,
  EVIDENCE_SLIDE_TRANSACTION_FORMAT_V1,
  EVIDENCE_TRANSACTION_FORMATS,
  evidenceTransactionFormatOfWork,
  isEvidenceSegment,
  isEvidenceSegmentV2,
} from "./evidence-segment-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "./jcs.ts";

/**
 * SRV-V14-PARSERI-BEZ-NODE (SRV-V14-SHEET-COMMIT t. 1): a segment may name the
 * spreadsheet and slides step formats, and then every step is read by that
 * document's own reader (`parseSheetSteps`, `parseSlideSteps`). The readers
 * carry no Node module, so the client and the server keep one check (granica
 * 8, #638). Whether a work takes a format stays the server's acceptance's to
 * decide by the work's kind (server/evidence/service.ts). Every value is
 * invented.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const SHEET = "00000000-0000-4000-8000-000000000000";
const SLIDE = "11111111-1111-4111-8111-111111111111";

const sheetSteps: JcsJsonValue[] = [{ type: "cellSet", sheetId: SHEET, ref: "A1", value: "demo" }];
const slideSteps: JcsJsonValue[] = [
  { type: "slideAdd", slideId: SLIDE, layout: "title", index: 0 },
];
const textSteps: JcsJsonValue[] = [
  { stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text: "A" }] } },
];

function segment(
  format: string,
  steps: JcsJsonValue,
  source = "editor",
  schema: string = EVIDENCE_SEGMENT_SCHEMA_V2,
): Record<string, JcsJsonValue> {
  return {
    evidenceSchema: schema,
    canonicalization: EVIDENCE_CANONICALIZATION_V2,
    hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
    documentId: "doc-v14",
    sessionId: "session-v14",
    segmentId: "segment-v14",
    sequenceFrom: 1,
    sequenceTo: 1,
    observedStartedAt: "2026-11-26T10:00:00.000Z",
    observedEndedAt: "2026-11-26T10:01:00.000Z",
    initialDocumentHash: A,
    finalDocumentHash: B,
    predecessorSegmentHash: null,
    events: [{ sequence: 1, source, steps, beforeDocumentHash: A, afterDocumentHash: B }],
    captureContext: { editorModel: "prosemirror", transactionFormat: format },
    evidenceProfileId: "standard-v1",
  };
}

const bytes = (value: unknown) => new TextEncoder().encode(canonicalizeJcs(value as JcsJsonValue));

describe("segment step formats of a spreadsheet and a slides work", () => {
  it("writes the two formats as the documents' own constants", () => {
    expect(EVIDENCE_SHEET_TRANSACTION_FORMAT_V1).toBe(SHEET_STEP_FORMAT_V1);
    expect(EVIDENCE_SLIDE_TRANSACTION_FORMAT_V1).toBe(SLIDE_STEP_FORMAT_V1);
    expect(EVIDENCE_SEGMENT_TRANSACTION_FORMATS).toEqual([
      ...EVIDENCE_TRANSACTION_FORMATS,
      SHEET_STEP_FORMAT_V1,
      SLIDE_STEP_FORMAT_V1,
    ]);
  });

  it("leaves the text formats and the format of a text work as they were", () => {
    expect(EVIDENCE_TRANSACTION_FORMATS).not.toContain(SHEET_STEP_FORMAT_V1);
    expect(EVIDENCE_TRANSACTION_FORMATS).not.toContain(SLIDE_STEP_FORMAT_V1);
    for (const version of [1, 2, 3, 4, 5, "spreadsheet", "slides", null]) {
      expect(evidenceTransactionFormatOfWork(version)).not.toBe(SHEET_STEP_FORMAT_V1);
      expect(evidenceTransactionFormatOfWork(version)).not.toBe(SLIDE_STEP_FORMAT_V1);
    }
  });

  it.each([
    ["spreadsheet", SHEET_STEP_FORMAT_V1, sheetSteps],
    ["slides", SLIDE_STEP_FORMAT_V1, slideSteps],
  ])("takes the steps of a %s work, byte for byte, in v2 and v3", async (_, format, steps) => {
    for (const value of [
      segment(format, steps),
      segment(format, steps, "citation-form", EVIDENCE_SEGMENT_SCHEMA_V3),
    ]) {
      expect(isEvidenceSegment(value)).toBe(true);
      const verified = await verifyCanonicalEvidencePayloadV2(bytes(value));
      expect(verified.ok && verified.segment.captureContext.transactionFormat).toBe(format);
    }
    expect(isEvidenceSegmentV2(segment(format, steps))).toBe(true);
  });

  it.each([
    ["text steps under the spreadsheet format", SHEET_STEP_FORMAT_V1, textSteps],
    ["slide steps under the spreadsheet format", SHEET_STEP_FORMAT_V1, slideSteps],
    ["text steps under the slides format", SLIDE_STEP_FORMAT_V1, textSteps],
    ["spreadsheet steps under the slides format", SLIDE_STEP_FORMAT_V1, sheetSteps],
    ["spreadsheet steps under a text format", EDIT_STEP_FORMAT_V1, sheetSteps],
    ["slide steps under a text format", EDIT_STEP_FORMAT_V1, slideSteps],
    ["no steps", SHEET_STEP_FORMAT_V1, []],
    ["no array", SLIDE_STEP_FORMAT_V1, slideSteps[0]!],
    ["an unknown step", SHEET_STEP_FORMAT_V1, [{ type: "cellMerge", sheetId: SHEET }]],
    ["an unknown field", SHEET_STEP_FORMAT_V1, [{ ...(sheetSteps[0] as object), at: 1 }]],
    ["a time field", SLIDE_STEP_FORMAT_V1, [{ ...(slideSteps[0] as object), time: 1 }]],
    [
      "a removal without its hash",
      SHEET_STEP_FORMAT_V1,
      [{ type: "cellClear", sheetId: SHEET, ref: "A1" }],
    ],
    [
      "a removal with an upper-case hash",
      SLIDE_STEP_FORMAT_V1,
      [{ type: "slideRemove", slideId: SLIDE, removedSha256: "A".repeat(64) }],
    ],
    [
      "a cell outside A1 notation",
      SHEET_STEP_FORMAT_V1,
      [{ type: "cellSet", sheetId: SHEET, ref: "1A", value: "x" }],
    ],
    ["too many steps", SHEET_STEP_FORMAT_V1, Array.from({ length: 1001 }, () => sheetSteps[0]!)],
  ])("refuses %s", async (_, format, steps) => {
    const value = segment(format, steps);
    expect(isEvidenceSegment(value)).toBe(false);
    const verified = await verifyCanonicalEvidencePayloadV2(bytes(value));
    expect(verified.ok).toBe(false);
  });

  it("refuses a format that only looks like one of them", () => {
    for (const format of [
      "ductus-sheet-steps-v2",
      "ductus-slide-steps-v0",
      "Ductus-sheet-steps-v1",
      " ductus-sheet-steps-v1",
      "ductus-slides-steps-v1",
    ]) {
      expect(isEvidenceSegment(segment(format, sheetSteps))).toBe(false);
      expect(isEvidenceSegment(segment(format, slideSteps))).toBe(false);
    }
  });

  it("keeps the closed sources and the closed editor model for these formats", () => {
    expect(isEvidenceSegment(segment(SHEET_STEP_FORMAT_V1, sheetSteps, "keypress"))).toBe(false);
    expect(isEvidenceSegment(segment(SLIDE_STEP_FORMAT_V1, slideSteps, "applied-suggestion"))).toBe(
      false,
    );
    const grid = segment(SHEET_STEP_FORMAT_V1, sheetSteps);
    grid.captureContext = { editorModel: "grid", transactionFormat: SHEET_STEP_FORMAT_V1 };
    expect(isEvidenceSegment(grid)).toBe(false);
  });
});

/**
 * Granica 8 (#638): the segment check is in the browser bundle, so nothing it
 * imports, directly or through another module, may be a Node module. The
 * static `from "..."` and bare `import "..."` sources of each code file (a
 * statement line, never a comment) are followed (lint allows no other form: local/import-boundary,
 * no-dynamic-load); the bundle itself is built by
 * server/external/storage/edit-steps-v1-browser-replayer.test.ts.
 */
describe("the step readers of the segment check import no Node module", () => {
  const SELF = path.dirname(fileURLToPath(import.meta.url));

  function closure(entry: string): { files: string[]; packages: string[] } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      const source = readFileSync(file, "utf8");
      const specs = [
        ...source.matchAll(
          /^(?:import|export|\})[^\n]*?\bfrom\s+"([^"]+)";$|^import\s+"([^"]+)";$/gm,
        ),
      ];
      for (const [, from, bare] of specs) {
        const fileName = (from ?? bare)!;
        if (fileName.startsWith(".")) queue.push(path.resolve(path.dirname(file), fileName));
        else packages.add(fileName);
      }
    }
    return { files: [...files], packages: [...packages] };
  }

  it("reaches the spreadsheet and slides readers with no package at all", () => {
    const { files, packages } = closure(path.join(SELF, "evidence-segment-v2.ts"));
    const reached = files.map((file) => path.relative(path.join(SELF, ".."), file));
    expect(reached).toContain(path.join("sheet", "model", "steps.ts"));
    expect(reached).toContain(path.join("slides", "model", "steps.ts"));
    expect(packages).toEqual([]);
  });

  it("would see a Node module that a reader imported", () => {
    // The hash helpers that the readers left behind do import node:crypto.
    for (const file of ["sheet/step-hash.ts", "slides/step-hash.ts"]) {
      expect(closure(path.join(SELF, "..", file)).packages).toEqual(["node:crypto"]);
    }
  });
});
