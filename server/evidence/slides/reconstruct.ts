// SRV-V13-EVIDENCE-SLAJD: the replay of a slides work. The step replayer of
// `ductus-slide-steps-v1` behind the generic interface of the evidence replay
// (server/domain/forensics/evidence-replay-v2.ts): reconstruction and replay
// check, event by event, that the recorded steps give the recorded hashes,
// exactly as for text, so signature, chain and receipt need no other format.
import {
  applySlideSteps,
  parseSlideSteps,
  replayEvidenceSegmentsV2,
  SLIDE_STEP_FORMAT_V1,
  slidesRevisionZeroDocument,
  validateSlidesDocument,
  EvidenceContentNotSupportedV2,
  type EvidenceReplayResultV2,
  type EvidenceSegment,
  type EvidenceStepReplayerV2,
  type JcsJsonValue,
  type SlidesDocument,
} from "../../domain/index.ts";

/** Applies the steps of an event to a slides document, or throws; never guesses. */
export const slidesStepReplayer: EvidenceStepReplayerV2<SlidesDocument> = {
  transactionFormat: SLIDE_STEP_FORMAT_V1,
  load(canonical) {
    const valid = validateSlidesDocument(canonical);
    if (!valid.ok) throw new Error("invalid slides document");
    return valid.doc;
  },
  apply(document, event) {
    const parsed = parseSlideSteps(event.steps);
    // A step this server does not know is unreadable here, not shown to be wrong.
    if (!parsed.ok) throw new EvidenceContentNotSupportedV2("slide-step");
    const applied = applySlideSteps(document, parsed.steps);
    if (!applied.ok) throw new Error(`slide step refused: ${applied.error}`);
    return applied.doc;
  },
  toCanonical: (document) => document as unknown as JcsJsonValue,
};

/**
 * Replays verified segments of a slides work from revision 0 (or from
 * `startDocument`, a checkpoint the caller has already verified).
 */
export function replaySlidesSegments(
  segments: readonly EvidenceSegment[],
  startDocument: JcsJsonValue = slidesRevisionZeroDocument() as unknown as JcsJsonValue,
): Promise<EvidenceReplayResultV2> {
  return replayEvidenceSegmentsV2(startDocument, segments, slidesStepReplayer);
}
