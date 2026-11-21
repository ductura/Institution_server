import {
  canonicalizeJcs,
  sha256WebCrypto,
  type AsyncEvidenceStepReplayerV2,
  type EvidenceSegment,
  type JcsJsonValue,
} from "../../domain/index.ts";

/**
 * How many accepted segments lie between two reconstruction checkpoints
 * (SRV-1503, plan M3.3). A read of a revision replays at most this many
 * segments past the newest checkpoint before it; the full record is replayed
 * only when no checkpoint is usable.
 */
export const RECONSTRUCTION_CHECKPOINT_INTERVAL = 50;

/** The table's own limit on a checkpoint text, in UTF-8 bytes. */
export const RECONSTRUCTION_CHECKPOINT_MAX_BYTES = 2_097_152;

/**
 * The document after revision `revision`, as the store holds it. Revision `r`
 * is the state after the `r`-th accepted segment of a package (a work opened
 * at revision 0); `segmentHash` names that segment and `contentHash` is the
 * SHA-256 of `body`'s UTF-8 bytes. Nothing in it is trusted before
 * {@link verifyReconstructionCheckpoint}.
 */
export type ReconstructionCheckpoint = {
  revision: number;
  segmentHash: string;
  contentHash: string;
  body: string;
};

/** One accepted segment whose chain has already been verified, with its hash. */
export type VerifiedEvidenceSegment = {
  segmentHash: string;
  segment: EvidenceSegment;
};

export type CheckpointRejection =
  /** The checkpoint lies after the asked revision or outside the record. */
  | "beyond_revision"
  /** The segment at its revision is not the one it names. */
  | "position_mismatch"
  /** Its text does not hash to its key or to the segment's final document. */
  | "hash_mismatch"
  /** Its text is not the canonical form of a document the replayer reads. */
  | "invalid_document";

export type CheckpointVerification<TDocument> =
  { ok: true; document: TDocument } | { ok: false; reason: CheckpointRejection };

const isRevision = (value: number) => Number.isSafeInteger(value) && value >= 1;

/**
 * Whether `checkpoint` is the document the verified record ends in after its
 * revision, for a read of `revision`. It must sit at a position of this
 * record (the segment there carries its segment hash), its bytes must hash to
 * its key and to that segment's `finalDocumentHash`, and they must be exactly
 * the canonical form of what the replayer loads from them. Only then may a
 * replay start from it instead of from the start.
 */
export async function verifyReconstructionCheckpoint<TDocument>(
  checkpoint: ReconstructionCheckpoint,
  segments: readonly VerifiedEvidenceSegment[],
  revision: number,
  replayer: AsyncEvidenceStepReplayerV2<TDocument>,
): Promise<CheckpointVerification<TDocument>> {
  if (
    !isRevision(checkpoint.revision) ||
    checkpoint.revision > revision ||
    checkpoint.revision > segments.length
  ) {
    return { ok: false, reason: "beyond_revision" };
  }
  const at = segments[checkpoint.revision - 1]!;
  if (at.segmentHash !== checkpoint.segmentHash) return { ok: false, reason: "position_mismatch" };
  if (
    typeof checkpoint.body !== "string" ||
    new TextEncoder().encode(checkpoint.body).byteLength > RECONSTRUCTION_CHECKPOINT_MAX_BYTES
  ) {
    return { ok: false, reason: "invalid_document" };
  }
  const bodyHash = await sha256WebCrypto(checkpoint.body);
  if (bodyHash !== checkpoint.contentHash || bodyHash !== at.segment.finalDocumentHash) {
    return { ok: false, reason: "hash_mismatch" };
  }
  try {
    const document = replayer.load(JSON.parse(checkpoint.body) as JcsJsonValue);
    if (canonicalizeJcs(replayer.toCanonical(document)) !== checkpoint.body) {
      return { ok: false, reason: "invalid_document" };
    }
    return { ok: true, document };
  } catch {
    return { ok: false, reason: "invalid_document" };
  }
}

/**
 * The revisions a record of `segmentCount` segments still needs a checkpoint
 * at: every multiple of `interval` after `newestRevision` (`null` when the
 * package has none), up to and including the last segment, oldest first.
 */
export function checkpointRevisionsDue(
  segmentCount: number,
  newestRevision: number | null,
  interval: number = RECONSTRUCTION_CHECKPOINT_INTERVAL,
): number[] {
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError("invalid interval");
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 0) return [];
  const due: number[] = [];
  const after = newestRevision ?? 0;
  for (let revision = interval; revision <= segmentCount; revision += interval) {
    if (revision > after) due.push(revision);
  }
  return due;
}
