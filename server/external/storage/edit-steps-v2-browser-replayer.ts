import { EDIT_STEP_FORMAT_V2, EDIT_STEP_FORMAT_V3 } from "../../domain/document/edit-step.ts";
import { sha256WebCrypto } from "../../domain/forensics/crypto.ts";
import type { AsyncEvidenceStepReplayerV2 } from "../../domain/forensics/evidence-replay-v2.ts";
import type { EvidenceEventV3 } from "../../domain/forensics/evidence-segment-v2.ts";

import { refuse } from "./edit-steps-v1-rules.ts";
import {
  editStepsCanonical,
  loadEditStepsDocument,
  runEditSteps,
  type EditStepsV2Document,
  type EditStepsVersion,
} from "./edit-steps-v2-rules.ts";

/**
 * Browser entry of the `ductus-edit-steps-v2` replayer: the same rules and the
 * same order of checks as `edit-steps-v2-replayer.ts`, with every claim hashed
 * by Web Crypto, so `apply` is async. No Node module may be imported here.
 * Without Web Crypto every hash fails and the replay fails closed, as in v1.
 */
export function createBrowserEditStepsV2Replayer(): AsyncEvidenceStepReplayerV2<EditStepsV2Document> {
  return createBrowserReplayer(2);
}

/** Browser replayer of `ductus-edit-steps-v3` (SRV-7A, contract v3 §5), the same driver. */
export function createBrowserEditStepsV3Replayer(): AsyncEvidenceStepReplayerV2<EditStepsV2Document> {
  return createBrowserReplayer(3);
}

function createBrowserReplayer(
  version: EditStepsVersion,
): AsyncEvidenceStepReplayerV2<EditStepsV2Document> {
  return {
    transactionFormat: version === 2 ? EDIT_STEP_FORMAT_V2 : EDIT_STEP_FORMAT_V3,
    load: (canonical) => loadEditStepsDocument(version, canonical),
    async apply(state: EditStepsV2Document, event: EvidenceEventV3): Promise<EditStepsV2Document> {
      const run = runEditSteps(version, state, event);
      for (let next = run.next(); ; next = run.next()) {
        if (next.done) {
          return next.value;
        }
        if ((await sha256WebCrypto(next.value.canonical)) !== next.value.recorded) {
          refuse("removed_range_hash");
        }
      }
    },
    toCanonical: (state) => editStepsCanonical(version, state),
  };
}
