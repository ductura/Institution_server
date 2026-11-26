// SRV-V14-PROJEKCIJE-FORMAT: the process summary counts characters from
// ProseMirror steps only, so it must refuse a segment recorded in a spreadsheet
// or slides step format with the existing `invalid_segment`, never give a
// quiet zero. The segment check on this base still refuses those formats; once
// it takes them (SRV-V14-PARSERI-BEZ-NODE) a verified segment can carry them.
// That check is simulated here: the payload verification the projection calls
// gives back the real verified segment with the recorded format of the test.
// The chain itself is verified for real. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EDIT_STEP_FORMAT_V1, EDIT_STEP_FORMAT_V3 } from "../document/index.ts";
import {
  canonicalEvidenceSegmentV2,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  EVIDENCE_TRANSACTION_FORMAT_V4,
  sha256WebCrypto,
  type EvidenceChainHeadV2,
  type verifyCanonicalEvidencePayloadV2,
} from "../forensics/index.ts";
import { SHEET_STEP_FORMAT_V1 } from "../sheet/index.ts";
import { SLIDE_STEP_FORMAT_V1 } from "../slides/index.ts";

import { projectProcessSummary } from "./process-summary.ts";

/** The format each verified payload is given, by position; `undefined` keeps it. */
const recorded = vi.hoisted(() => ({ formats: [] as unknown[], calls: 0 }));

vi.mock("../forensics/evidence-chain-v2.ts", async (importOriginal) => {
  const actual = await importOriginal<{
    verifyCanonicalEvidencePayloadV2: typeof verifyCanonicalEvidencePayloadV2;
  }>();
  return {
    ...actual,
    verifyCanonicalEvidencePayloadV2: async (payload: unknown) => {
      const verified = await actual.verifyCanonicalEvidencePayloadV2(payload);
      const format = recorded.formats[recorded.calls++];
      if (!verified.ok || format === undefined) return verified;
      return {
        ...verified,
        segment: {
          ...verified.segment,
          captureContext: { ...verified.segment.captureContext, transactionFormat: format },
        },
      };
    },
  };
});

const THRESHOLDS = { sessionBreakAboveMinutes: 30, pasteListedAboveCharacters: 5 };
const hash = (n: number) => n.toString(16).padStart(64, "0");

/** A package of `count` one-minute segments, each with one paste of Lorem ipsum. */
async function buildPackage(
  count: number,
): Promise<{ payloads: string[]; head: EvidenceChainHeadV2 }> {
  const payloads: string[] = [];
  let previousHash: string | null = null;
  for (let index = 0; index < count; index++) {
    const minute = `2026-10-20T10:${String(index * 5).padStart(2, "0")}:00.000Z`;
    const canonical = canonicalEvidenceSegmentV2({
      evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
      canonicalization: EVIDENCE_CANONICALIZATION_V2,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
      documentId: "doc-format",
      sessionId: "doc-format-session",
      segmentId: `doc-format-segment-${index + 1}`,
      sequenceFrom: index + 1,
      sequenceTo: index + 1,
      observedStartedAt: minute,
      observedEndedAt: minute,
      initialDocumentHash: hash(index + 1),
      finalDocumentHash: hash(index + 2),
      predecessorSegmentHash: previousHash,
      events: [
        {
          sequence: index + 1,
          source: "paste",
          steps: [
            {
              stepType: "replace",
              from: 1,
              to: 1,
              slice: { content: [{ type: "text", text: "Lorem ipsum dolor" }] },
            },
          ],
          beforeDocumentHash: hash(index + 1),
          afterDocumentHash: hash(index + 2),
        },
      ],
      captureContext: { editorModel: "prosemirror", transactionFormat: EDIT_STEP_FORMAT_V1 },
      evidenceProfileId: "standard-v1",
    });
    payloads.push(canonical);
    previousHash = await sha256WebCrypto(canonical);
  }
  return { payloads, head: { segmentHash: previousHash!, segmentCount: count } };
}

async function summarizeAs(formats: unknown[]) {
  recorded.formats = formats;
  return projectProcessSummary({ ...(await buildPackage(formats.length)), thresholds: THRESHOLDS });
}

beforeEach(() => {
  recorded.formats = [];
  recorded.calls = 0;
});

describe("process summary by recorded step format (SRV-V14-PROJEKCIJE-FORMAT)", () => {
  it("summarises segments of every text format", async () => {
    for (const format of [
      EDIT_STEP_FORMAT_V1,
      EDIT_STEP_FORMAT_V3,
      EVIDENCE_TRANSACTION_FORMAT_V4,
    ]) {
      recorded.calls = 0;
      const result = await summarizeAs([format, format]);
      expect(result.ok && result.summary.pastes.listed.map((item) => item.characters)).toEqual([
        17, 17,
      ]);
    }
  });

  it("refuses a spreadsheet segment with invalid_segment, never a summary", async () => {
    expect(await summarizeAs([SHEET_STEP_FORMAT_V1])).toEqual({
      ok: false,
      reason: "invalid_segment",
    });
  });

  it("refuses a slides segment with invalid_segment, never a summary", async () => {
    expect(await summarizeAs([SLIDE_STEP_FORMAT_V1])).toEqual({
      ok: false,
      reason: "invalid_segment",
    });
  });

  it("refuses the whole package when one segment of many is not text", async () => {
    for (const other of [SHEET_STEP_FORMAT_V1, SLIDE_STEP_FORMAT_V1]) {
      recorded.calls = 0;
      expect(await summarizeAs([undefined, other, undefined])).toEqual({
        ok: false,
        reason: "invalid_segment",
      });
    }
  });

  it("refuses formats no check names", async () => {
    for (const format of ["ductus-edit-steps-v2", "", null, 1]) {
      recorded.calls = 0;
      expect(await summarizeAs([format])).toEqual({ ok: false, reason: "invalid_segment" });
    }
  });
});
