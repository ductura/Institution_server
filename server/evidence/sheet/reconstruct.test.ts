// SRV-V14-SHEET-EVIDENCE: the replay of a spreadsheet work. All ids and texts are invented.
import { describe, expect, it } from "vitest";

import {
  applySheetSteps,
  digestCanonicalDocumentV2,
  parseSheetSteps,
  SHEET_STEP_FORMAT_V1,
  sheetJcsBytes,
  sheetRevisionZeroDocument,
  type EvidenceSegment,
  type JcsJsonValue,
  type SheetDocument,
  type SheetStep,
} from "../../domain/index.ts";

import { replaySheetSegments, sheetStepReplayer } from "./reconstruct.ts";

const S = "00000000-0000-4000-8000-000000000000";
const canon = (doc: SheetDocument) => doc as unknown as JcsJsonValue;
const hash = async (doc: SheetDocument) => (await digestCanonicalDocumentV2(canon(doc))).sha256;

const STEPS_1: SheetStep[] = [{ type: "cellSet", sheetId: S, ref: "A1", value: "demo" }];
const STEPS_2: SheetStep[] = [{ type: "cellSet", sheetId: S, ref: "B1", formula: "=1+1" }];

async function record(stepLists: SheetStep[][], format: string = SHEET_STEP_FORMAT_V1) {
  let doc = sheetRevisionZeroDocument();
  const segments: EvidenceSegment[] = [];
  let sequence = 1;
  for (const steps of stepLists) {
    const before = await hash(doc);
    const applied = applySheetSteps(doc, steps);
    if (!applied.ok) throw new Error("fixture refused");
    doc = applied.doc;
    const after = await hash(doc);
    segments.push({
      initialDocumentHash: before,
      finalDocumentHash: after,
      captureContext: { editorModel: "grid", transactionFormat: format },
      events: [
        {
          sequence: sequence++,
          source: "editor",
          steps: steps as never,
          beforeDocumentHash: before,
          afterDocumentHash: after,
        },
      ],
    } as unknown as EvidenceSegment);
  }
  return { segments, final: doc };
}

describe("replaySheetSegments", () => {
  it("rebuilds the final document of a chain from revision 0", async () => {
    const { segments, final } = await record([STEPS_1, STEPS_2]);
    expect(await replaySheetSegments(segments)).toEqual({
      ok: true,
      canonicalDocument: Buffer.from(sheetJcsBytes(final)).toString("utf8"),
      documentSha256: await hash(final),
    });
  });

  it("fails when a recorded hash is not what the steps produce", async () => {
    const { segments } = await record([STEPS_1, STEPS_2]);
    (segments[1] as { events: { afterDocumentHash: string }[] }).events[0]!.afterDocumentHash =
      "e".repeat(64);
    expect(await replaySheetSegments(segments)).toMatchObject({
      ok: false,
      reason: "document_hash_mismatch",
      segmentIndex: 1,
    });
  });

  it("fails when a segment does not start from the document before it", async () => {
    const { segments } = await record([STEPS_1, STEPS_2]);
    expect(await replaySheetSegments(segments.slice(1))).toMatchObject({
      ok: false,
      reason: "document_hash_mismatch",
      segmentIndex: 0,
    });
  });

  it("refuses a text step format on a spreadsheet work as unsupported_format", async () => {
    const { segments } = await record([STEPS_1], "ductus-edit-steps-v1");
    expect(await replaySheetSegments(segments)).toMatchObject({
      ok: false,
      reason: "unsupported_format",
    });
  });

  it("refuses a step the format does not know as unsupported_format, never as applied", async () => {
    const { segments } = await record([STEPS_1]);
    (segments[0] as { events: { steps: unknown[] }[] }).events[0]!.steps = [{ type: "cellSpin" }];
    expect(await replaySheetSegments(segments)).toMatchObject({
      ok: false,
      reason: "unsupported_format",
      sequence: 1,
    });
  });

  it("fails a step the document refuses (a sheet that is not there)", async () => {
    const { segments } = await record([STEPS_1]);
    (segments[0] as { events: { steps: unknown[] }[] }).events[0]!.steps = [
      { type: "rowInsert", sheetId: "99999999-9999-4999-8999-999999999999", row: 1 },
    ];
    expect(await replaySheetSegments(segments)).toMatchObject({ ok: false, reason: "step_failed" });
  });

  it("refuses a start that is no spreadsheet document", async () => {
    const { segments } = await record([STEPS_1]);
    expect(await replaySheetSegments(segments, { schemaVersion: 1, nodes: [] })).toMatchObject({
      ok: false,
      reason: "invalid_document",
    });
  });
});

describe("sheetStepReplayer", () => {
  it("has the sheet step format", () => {
    expect(sheetStepReplayer.transactionFormat).toBe(SHEET_STEP_FORMAT_V1);
    expect(parseSheetSteps(STEPS_1).ok).toBe(true);
  });
});
