// SRV-V14-SHEET-EVIDENCE: the replay of a spreadsheet work. The step replayer of
// `ductus-sheet-steps-v1` behind the generic interface of the evidence replay
// (server/domain/forensics/evidence-replay-v2.ts): reconstruction and replay
// check, event by event, that the recorded steps give the recorded hashes,
// exactly as for text and slides, so signature, chain and receipt need no
// other format. The computed result of a formula is never part of the replay:
// a formula cell stores no result.
import {
  applySheetSteps,
  parseSheetSteps,
  replayEvidenceSegmentsV2,
  sheetRevisionZeroDocument,
  validateSheetDocument,
  SHEET_STEP_FORMAT_V1,
  EvidenceContentNotSupportedV2,
  type EvidenceReplayResultV2,
  type EvidenceSegment,
  type EvidenceStepReplayerV2,
  type JcsJsonValue,
  type SheetDocument,
} from "../../domain/index.ts";

/** Applies the steps of an event to a spreadsheet document, or throws; never guesses. */
export const sheetStepReplayer: EvidenceStepReplayerV2<SheetDocument> = {
  transactionFormat: SHEET_STEP_FORMAT_V1,
  load(canonical) {
    const valid = validateSheetDocument(canonical);
    if (!valid.ok) throw new Error("invalid sheet document");
    return valid.doc;
  },
  apply(document, event) {
    const parsed = parseSheetSteps(event.steps);
    // A step this server does not know is unreadable here, not shown to be wrong.
    if (!parsed.ok) throw new EvidenceContentNotSupportedV2("sheet-step");
    const applied = applySheetSteps(document, parsed.steps);
    if (!applied.ok) throw new Error(`sheet step refused: ${applied.error}`);
    return applied.doc;
  },
  toCanonical: (document) => document as unknown as JcsJsonValue,
};

/**
 * Replays verified segments of a spreadsheet work from revision 0 (or from
 * `startDocument`, a checkpoint the caller has already verified).
 */
export function replaySheetSegments(
  segments: readonly EvidenceSegment[],
  startDocument: JcsJsonValue = sheetRevisionZeroDocument() as unknown as JcsJsonValue,
): Promise<EvidenceReplayResultV2> {
  return replayEvidenceSegmentsV2(startDocument, segments, sheetStepReplayer);
}
