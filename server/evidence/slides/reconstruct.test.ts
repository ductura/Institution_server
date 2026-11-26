// SRV-V13-EVIDENCE-SLAJD: the replay of a slides work. All ids and texts are invented.
import { describe, expect, it } from "vitest";

import {
  applySlideSteps,
  digestCanonicalDocumentV2,
  parseSlideSteps,
  SLIDE_STEP_FORMAT_V1,
  slidesRevisionZeroDocument,
  slidesSnapshotText,
  type EvidenceSegment,
  type JcsJsonValue,
  type SlideStep,
  type SlidesDocument,
} from "../../domain/index.ts";

import { replaySlidesSegments, slidesStepReplayer } from "./reconstruct.ts";

const S1 = "00000000-0000-4000-8000-000000000000";
const S2 = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";

const canon = (doc: SlidesDocument) => doc as unknown as JcsJsonValue;
const hash = async (doc: SlidesDocument) => (await digestCanonicalDocumentV2(canon(doc))).sha256;

const STEPS_1: SlideStep[] = [{ type: "slideAdd", slideId: S2, layout: "title", index: 1 }];
const STEPS_2: SlideStep[] = [
  {
    type: "blockSet",
    slideId: S2,
    index: 0,
    block: { type: "heading", id: B1, slot: "title", text: "Uvod" },
  },
];

/** One segment per step list, chained from revision 0; a minimal shape: replay reads only these fields. */
async function record(stepLists: SlideStep[][], format: string = SLIDE_STEP_FORMAT_V1) {
  let doc = slidesRevisionZeroDocument();
  const segments: EvidenceSegment[] = [];
  let sequence = 1;
  for (const steps of stepLists) {
    const before = await hash(doc);
    const applied = applySlideSteps(doc, steps);
    if (!applied.ok) throw new Error("fixture refused");
    doc = applied.doc;
    const after = await hash(doc);
    segments.push({
      initialDocumentHash: before,
      finalDocumentHash: after,
      captureContext: { editorModel: "prosemirror", transactionFormat: format },
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

describe("replaySlidesSegments", () => {
  it("rebuilds the final document of a chain from revision 0", async () => {
    const { segments, final } = await record([STEPS_1, STEPS_2]);
    const result = await replaySlidesSegments(segments);
    expect(result).toEqual({
      ok: true,
      canonicalDocument: slidesSnapshotText(final),
      documentSha256: await hash(final),
    });
  });

  it("fails when a recorded hash is not what the steps produce", async () => {
    const { segments } = await record([STEPS_1, STEPS_2]);
    (segments[1] as { events: { afterDocumentHash: string }[] }).events[0]!.afterDocumentHash =
      "e".repeat(64);
    expect(await replaySlidesSegments(segments)).toMatchObject({
      ok: false,
      reason: "document_hash_mismatch",
      segmentIndex: 1,
      sequence: 2,
    });
  });

  it("fails when a segment does not start from the document before it", async () => {
    const { segments } = await record([STEPS_1, STEPS_2]);
    expect(await replaySlidesSegments(segments.slice(1))).toMatchObject({
      ok: false,
      reason: "document_hash_mismatch",
      segmentIndex: 0,
    });
  });

  it("refuses a text step format on a slides work as unsupported_format", async () => {
    const { segments } = await record([STEPS_1], "ductus-edit-steps-v1");
    expect(await replaySlidesSegments(segments)).toMatchObject({
      ok: false,
      reason: "unsupported_format",
      segmentIndex: 0,
    });
  });

  it("refuses a step the format does not know as unsupported_format, never as applied", async () => {
    const { segments } = await record([STEPS_1]);
    (segments[0] as { events: { steps: unknown[] }[] }).events[0]!.steps = [{ type: "slideSpin" }];
    expect(await replaySlidesSegments(segments)).toMatchObject({
      ok: false,
      reason: "unsupported_format",
      sequence: 1,
    });
  });

  it("fails a step the document refuses (a slide that is not there)", async () => {
    const { segments } = await record([STEPS_1]);
    (segments[0] as { events: { steps: unknown[] }[] }).events[0]!.steps = [
      { type: "slideMove", slideId: "99999999-9999-4999-8999-999999999999", toIndex: 0 },
    ];
    expect(await replaySlidesSegments(segments)).toMatchObject({
      ok: false,
      reason: "step_failed",
    });
  });

  it("refuses a start that is no slides document", async () => {
    const { segments } = await record([STEPS_1]);
    expect(await replaySlidesSegments(segments, { schemaVersion: 1, nodes: [] })).toMatchObject({
      ok: false,
      reason: "invalid_document",
    });
  });
});

describe("slidesStepReplayer", () => {
  it("has the slide step format and revision 0 of the first slide", () => {
    expect(slidesStepReplayer.transactionFormat).toBe(SLIDE_STEP_FORMAT_V1);
    expect(parseSlideSteps(STEPS_1).ok).toBe(true);
    expect(slidesRevisionZeroDocument().slides[0]!.id).toBe(S1);
  });
});
