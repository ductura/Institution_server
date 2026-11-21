import type { AsyncEvidenceStepReplayerV2, JcsJsonValue } from "../../domain/index.ts";
import {
  checkpointRevisionsDue,
  RECONSTRUCTION_CHECKPOINT_INTERVAL,
  type VerifiedEvidenceSegment,
} from "./checkpoint.ts";
import {
  buildReconstructionCheckpoints,
  readDocumentAtRevision,
  type RevisionReadResult,
} from "./read-at-revision.ts";
import type { CheckpointStoreFault, ReconstructionCheckpointStore } from "./store.ts";

type RecordInput<TDocument> = {
  store: ReconstructionCheckpointStore;
  evidencePackageId: string;
  initialDocument: JcsJsonValue;
  /** The package's accepted chain, already verified link by link. */
  segments: readonly VerifiedEvidenceSegment[];
  replayer: AsyncEvidenceStepReplayerV2<TDocument>;
};

/**
 * The document at `revision` of one package (SRV-1503): one read of the
 * newest checkpoint at or before it, then {@link readDocumentAtRevision}. A
 * store that does not answer is no reason to fail: the read replays the whole
 * record and says so in `fallback`.
 */
export async function readPackageRevision<TDocument>(
  input: RecordInput<TDocument> & { revision: number },
): Promise<RevisionReadResult> {
  const { store, evidencePackageId, revision } = input;
  let read: Awaited<ReturnType<ReconstructionCheckpointStore["readAtOrBefore"]>> = {
    status: "none",
  };
  if (Number.isSafeInteger(revision) && revision >= 1) {
    read = await store
      .readAtOrBefore({ evidencePackageId, revision })
      .catch(() => ({ status: "unavailable", reason: "checkpoints_failed" }) as const);
  }
  return readDocumentAtRevision({
    initialDocument: input.initialDocument,
    segments: input.segments,
    revision,
    replayer: input.replayer,
    checkpoint: read.status === "found" ? read.checkpoint : null,
    checkpointUnavailable: read.status === "unavailable",
  });
}

export type CheckpointRecordingResult =
  | { status: "done"; recorded: number[]; existing: number[] }
  /** The record does not replay; nothing is written. */
  | { status: "not_reproducible"; segmentIndex: number | null }
  /** The store refused a checkpoint or did not answer; what was written before stays. */
  | {
      status: "stopped";
      recorded: number[];
      reason: CheckpointStoreFault | "not_found" | "mismatch";
    };

/**
 * Writes the checkpoints the package still lacks, every `interval` segments
 * after its newest one, from one replay of the verified record. A checkpoint
 * is only ever the document the record reproduces at that revision, and the
 * database refuses one whose text is not the revision's committed text.
 */
export async function recordDueCheckpoints<TDocument>(
  input: RecordInput<TDocument> & { interval?: number },
): Promise<CheckpointRecordingResult> {
  const { store, evidencePackageId, segments } = input;
  const interval = input.interval ?? RECONSTRUCTION_CHECKPOINT_INTERVAL;
  if (segments.length < interval) return { status: "done", recorded: [], existing: [] };

  const newest = await store
    .readAtOrBefore({ evidencePackageId, revision: segments.length })
    .catch(() => ({ status: "unavailable", reason: "checkpoints_failed" }) as const);
  if (newest.status === "unavailable")
    return { status: "stopped", recorded: [], reason: newest.reason };
  const due = checkpointRevisionsDue(
    segments.length,
    newest.status === "found" ? newest.checkpoint.revision : null,
    interval,
  );
  if (due.length === 0) return { status: "done", recorded: [], existing: [] };

  const built = await buildReconstructionCheckpoints({
    initialDocument: input.initialDocument,
    segments,
    revisions: due,
    replayer: input.replayer,
  });
  if (!built.ok) return { status: "not_reproducible", segmentIndex: built.segmentIndex };

  const recorded: number[] = [];
  const existing: number[] = [];
  for (const checkpoint of built.checkpoints) {
    const result = await store
      .record({ evidencePackageId, checkpoint })
      .catch(() => ({ status: "unavailable", reason: "checkpoints_failed" }) as const);
    if (result.status === "recorded") recorded.push(checkpoint.revision);
    else if (result.status === "exists") existing.push(checkpoint.revision);
    else {
      return {
        status: "stopped",
        recorded,
        reason: result.status === "unavailable" ? result.reason : result.status,
      };
    }
  }
  return { status: "done", recorded, existing };
}
