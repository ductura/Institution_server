import {
  replayEvidenceSegmentsV2,
  type AsyncEvidenceStepReplayerV2,
  type EvidenceReplayFailureV2,
  type JcsJsonValue,
} from "../../domain/index.ts";
import {
  verifyReconstructionCheckpoint,
  type CheckpointRejection,
  type ReconstructionCheckpoint,
  type VerifiedEvidenceSegment,
} from "./checkpoint.ts";

/** Why the checkpoint offered to a read was not used; the read then replays the whole record. */
export type CheckpointFallbackReason =
  | CheckpointRejection
  /** The store could not be read, which is no word on the record. */
  | "unavailable"
  /** The replay from a checkpoint that passed every check still failed. */
  | "replay_failed";

export type RevisionReadResult =
  | {
      ok: true;
      /** The document at the asked revision, as RFC 8785 JCS text. */
      canonicalDocument: string;
      documentSha256: string;
      /** `checkpoint` when the replay started at `startRevision`, `full` from the start. */
      source: "checkpoint" | "full";
      startRevision: number;
      /** Why an offered checkpoint was passed over; `null` when none was or it was used. */
      fallback: CheckpointFallbackReason | null;
    }
  | {
      ok: false;
      reason: EvidenceReplayFailureV2 | "revision_out_of_range";
      /** Index of the segment the replay stopped at, in the whole record. */
      segmentIndex: number | null;
      fallback: CheckpointFallbackReason | null;
    };

const outOfRange = { ok: false, reason: "revision_out_of_range", segmentIndex: null } as const;

/**
 * The document at `revision` of a verified record (SRV-1503): replayed from
 * `checkpoint` when it passes {@link verifyReconstructionCheckpoint}, otherwise
 * from `initialDocument` over the whole record up to that revision. Revision 0
 * is the starting document itself.
 *
 * `segments` must be the accepted chain already checked link by link (as the
 * reconstruction does with verifyEvidenceChainV2); this function checks only
 * that the replayed steps produce the recorded document hashes. A checkpoint
 * that is damaged, of another record or beyond the revision is never used, and
 * a replay from a checkpoint that fails falls back to the full replay, so the
 * answer is always the one the whole record gives.
 */
export async function readDocumentAtRevision<TDocument>(input: {
  initialDocument: JcsJsonValue;
  segments: readonly VerifiedEvidenceSegment[];
  revision: number;
  replayer: AsyncEvidenceStepReplayerV2<TDocument>;
  checkpoint: ReconstructionCheckpoint | null;
  /** Set when the store gave no answer; the read then replays the whole record. */
  checkpointUnavailable?: boolean;
}): Promise<RevisionReadResult> {
  const { initialDocument, segments, revision, replayer, checkpoint } = input;
  let fallback: CheckpointFallbackReason | null = input.checkpointUnavailable
    ? "unavailable"
    : null;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > segments.length) {
    return { ...outOfRange, fallback };
  }

  if (checkpoint !== null) {
    const verified = await verifyReconstructionCheckpoint(checkpoint, segments, revision, replayer);
    if (verified.ok) {
      const resumed = await replayEvidenceSegmentsV2(
        replayer.toCanonical(verified.document),
        segments.slice(checkpoint.revision, revision).map((item) => item.segment),
        replayer,
      );
      if (resumed.ok) {
        return {
          ok: true,
          canonicalDocument: resumed.canonicalDocument,
          documentSha256: resumed.documentSha256,
          source: "checkpoint",
          startRevision: checkpoint.revision,
          fallback: null,
        };
      }
      fallback = "replay_failed";
    } else {
      fallback = verified.reason;
    }
  }

  const full = await replayEvidenceSegmentsV2(
    initialDocument,
    segments.slice(0, revision).map((item) => item.segment),
    replayer,
  );
  if (!full.ok) {
    return { ok: false, reason: full.reason, segmentIndex: full.segmentIndex, fallback };
  }
  return {
    ok: true,
    canonicalDocument: full.canonicalDocument,
    documentSha256: full.documentSha256,
    source: "full",
    startRevision: 0,
    fallback,
  };
}

export type CheckpointBuildResult =
  | { ok: true; checkpoints: ReconstructionCheckpoint[] }
  | { ok: false; reason: EvidenceReplayFailureV2; segmentIndex: number | null };

/**
 * The checkpoints at `revisions` of a verified record, in one pass from the
 * start: each segment is replayed once and the document after it is kept
 * where a revision asks for it. A record whose replay fails yields none, so
 * a checkpoint never holds a document the record does not reproduce.
 */
export async function buildReconstructionCheckpoints<TDocument>(input: {
  initialDocument: JcsJsonValue;
  segments: readonly VerifiedEvidenceSegment[];
  revisions: readonly number[];
  replayer: AsyncEvidenceStepReplayerV2<TDocument>;
}): Promise<CheckpointBuildResult> {
  const { segments, replayer } = input;
  const wanted = new Set(input.revisions);
  const last = Math.max(0, ...[...wanted].filter((r) => Number.isSafeInteger(r) && r >= 1));
  const checkpoints: ReconstructionCheckpoint[] = [];
  let document = input.initialDocument;
  for (let index = 0; index < Math.min(last, segments.length); index++) {
    const step = await replayEvidenceSegmentsV2(document, [segments[index]!.segment], replayer);
    if (!step.ok) {
      return { ok: false, reason: step.reason, segmentIndex: index };
    }
    // The replay holds every event to its hashes; the segment's own final
    // hash is the chain check's. A checkpoint is the segment's final document,
    // so it is held to that hash here too.
    if (step.documentSha256 !== segments[index]!.segment.finalDocumentHash) {
      return { ok: false, reason: "document_hash_mismatch", segmentIndex: index };
    }
    if (wanted.has(index + 1)) {
      checkpoints.push({
        revision: index + 1,
        segmentHash: segments[index]!.segmentHash,
        contentHash: step.documentSha256,
        body: step.canonicalDocument,
      });
    }
    document = JSON.parse(step.canonicalDocument) as JcsJsonValue;
  }
  return { ok: true, checkpoints };
}
