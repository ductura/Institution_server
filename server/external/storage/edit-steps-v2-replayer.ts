import { createHash } from "node:crypto";

import {
  EDIT_STEP_FORMAT_V1,
  EDIT_STEP_FORMAT_V2,
  EDIT_STEP_FORMAT_V3,
} from "../../domain/document/edit-step.ts";
import type { DocumentSource } from "../../domain/document/schema.ts";
import type { EvidenceStepReplayerV2 } from "../../domain/forensics/evidence-replay-v2.ts";
import type { EvidenceEventV3 } from "../../domain/forensics/evidence-segment-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "../../domain/forensics/jcs.ts";

import { refuse } from "./edit-steps-v1-rules.ts";
import {
  editStepsCanonical,
  loadEditStepsDocument,
  runEditSteps,
  type EditStepsReadFormat,
  type EditStepsV2Document,
  type EditStepsVersion,
} from "./edit-steps-v2-rules.ts";

/**
 * Server replayer of `ductus-edit-steps-v2` (DAN-619, contract §5). The rules
 * are in `edit-steps-v2-rules.ts`, shared with the browser; this driver checks
 * each claim (a removed range or an old source record) synchronously with
 * `node:crypto`, at the point the rules ask for it. The browser driver is
 * `edit-steps-v2-browser-replayer.ts`.
 */

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * `removedSha256` of a `sourceSet` that replaces `source`, or of a
 * `sourceRemove` of it (§5.3): SHA-256 of the JCS of the record as the
 * document holds it right before the step. A removed range is hashed with
 * `removedRangeSha256` from the v1 driver; the definition is the same.
 */
export function sourceRecordSha256(source: DocumentSource): string {
  return sha256Hex(canonicalizeJcs(source as unknown as JcsJsonValue));
}

/** Replayer of `ductus-edit-steps-v2` for `replayEvidenceSegmentsV2`. */
export function createEditStepsV2Replayer(): EvidenceStepReplayerV2<EditStepsV2Document> {
  return createReplayer(2);
}

/** Replayer of `ductus-edit-steps-v3` (SRV-7A, contract v3 §5), the same driver. */
export function createEditStepsV3Replayer(): EvidenceStepReplayerV2<EditStepsV2Document> {
  return createReplayer(3);
}

/**
 * SRV-33C: replayer of `ductus-edit-steps-v1` over document v2, the one step
 * format a work of document v2 records (v4 §9 t. 9, `FORMAT_OF_WORK` in
 * domain/forensics/evidence-segment-v2.ts). It loads and writes document v2
 * and reads each event's steps as v1: a citation or a source step is refused,
 * as the v1 format has neither, and any other format of a segment is refused
 * by the replay, which compares it with `transactionFormat`.
 */
export function createEditStepsV1OnV2Replayer(): EvidenceStepReplayerV2<EditStepsV2Document> {
  return createReplayer(2, EDIT_STEP_FORMAT_V1);
}

function createReplayer(
  version: EditStepsVersion,
  format: EditStepsReadFormat = version === 2 ? EDIT_STEP_FORMAT_V2 : EDIT_STEP_FORMAT_V3,
): EvidenceStepReplayerV2<EditStepsV2Document> {
  return {
    transactionFormat: format,
    load: (canonical) => loadEditStepsDocument(version, canonical),
    apply(state: EditStepsV2Document, event: EvidenceEventV3): EditStepsV2Document {
      const run = runEditSteps(version, state, event, format);
      for (let next = run.next(); ; next = run.next()) {
        if (next.done) {
          return next.value;
        }
        if (sha256Hex(next.value.canonical) !== next.value.recorded) {
          refuse("removed_range_hash");
        }
      }
    },
    toCanonical: (state) => editStepsCanonical(version, state),
  };
}
