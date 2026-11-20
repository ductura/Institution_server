// The comparison of two versions of one work (SRV-9E, Ductus#2028; C-10).
// The server reconstructs both texts from the record itself: the segments
// the source lists, each checked as the replay checks it (canonical, under
// its listed hash, after the listed segment before it, of this document),
// replayed from revision 0 by the server's step replayer. That replayer
// checks every removed range against its recorded removedSha256 (B-12), so
// no text reaches the answer around that check. The stored checkpoint texts
// are never read. Revision r is the document after the first r segments:
// the database raises the revision only when it accepts a segment of the
// work's one package, one revision per segment. Access, the submission cut
// and the teacher's access log row come with the source, as in the replay;
// owner and teacher get the same answer (PRODUCT §5 rule 5).
import type { ReplaySource } from "../../database/index.ts";
import {
  EDIT_STEP_FORMAT_V1,
  EDIT_STEP_FORMAT_V3,
  type EvidenceSegment,
  type EvidenceStepReplayerV2,
  findEvidenceBreakV2,
  findEvidenceStartBreakV2,
  type JcsJsonValue,
  replayEvidenceSegmentsV2,
  REVISION_ZERO_JCS,
  REVISION_ZERO_V3_JCS,
  verifyCanonicalEvidencePayloadV2,
} from "../../domain/index.ts";
import type { InstitutionEvidencePayloadReader } from "../../external/storage/index.ts";
import { isReplayDocumentId } from "../index.ts";

import { blocksOf, type CompareEntry, diffBlocks, MAX_COMPARE_BLOCKS } from "./blocks.ts";

/** The most segments one comparison replays: the later revision may be at most this. */
export const MAX_COMPARE_SEGMENTS = 10_000;
/** The most stored bytes one comparison reads, counted before each segment is checked. */
export const MAX_COMPARE_READ_BYTES = 128 * 1024 * 1024;

export type CompareDeps<TV1, TV3> = {
  /** Already bound to the requesting session; decides access and lists the record. */
  readonly source: Pick<ReplaySource, "readSource">;
  /** Storage of every institution; bound here to the institution the source names. */
  readonly payloads: InstitutionEvidencePayloadReader;
  /**
   * The server's step replayers (external/storage), given by the caller:
   * `ductus-edit-steps-v1` over document v1 and `ductus-edit-steps-v3` over
   * document v3. A record in a format with no replayer here is `unsupported_format`.
   */
  readonly replayers: {
    readonly v1: EvidenceStepReplayerV2<TV1>;
    readonly v3?: EvidenceStepReplayerV2<TV3> | undefined;
  };
};

export type CompareUnavailableReason =
  | "source_unavailable"
  | "payload_missing"
  | "payload_unavailable"
  | "invalid_segment"
  | "segment_mismatch"
  | "unsupported_format"
  | "record_break"
  | "replay_failed"
  | "document_unreadable";

export type CompareResult =
  | { status: "ok"; from: number; to: number; blocks: CompareEntry[] }
  /** Another's, an unknown or a malformed work, or a revision the record does not hold. */
  | { status: "not_found" | "unauthenticated" | "invalid_input" | "too_large" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { status: "unavailable"; reason: CompareUnavailableReason };

const unavailable = (reason: CompareUnavailableReason): CompareResult => ({
  status: "unavailable",
  reason,
});

/** A revision that can be a version: a safe integer of at least 1. */
const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/** What stops a comparison before its answer. */
type Stop = CompareUnavailableReason | "too_large";

/** The checked segment at `index`, or why there is none. */
type NextSegment = (index: number) => Promise<EvidenceSegment | Stop>;

/** The document after revision `from` and after revision `to`, as canonical JCS texts. */
type Texts = { from: string; to: string } | Stop;

/**
 * Replays segments 0 to `to` - 1 from `zero`, one at a time as `next` reads
 * them, and keeps the document after revision `from` and after `to`. A break
 * anywhere before `to`, even one the hashes would let through, is
 * `record_break`: a comparison starts at revision 0 and never resumes from a
 * checkpoint.
 */
async function replayTo<TDocument>(
  replayer: EvidenceStepReplayerV2<TDocument>,
  zero: string,
  first: EvidenceSegment,
  next: NextSegment,
  from: number,
  to: number,
): Promise<Texts> {
  const start = await findEvidenceStartBreakV2(JSON.parse(zero) as JcsJsonValue, first, replayer);
  if (!start.ok) return "replay_failed";
  if (start.discontinuity !== null) return "record_break";
  let document = zero;
  let atFrom = "";
  let previous: EvidenceSegment | null = null;
  for (let index = 0; index < to; index++) {
    const segment = index === 0 ? first : await next(index);
    if (typeof segment === "string") return segment;
    if (previous !== null && findEvidenceBreakV2(index, previous, segment) !== null) {
      return "record_break";
    }
    const replayed = await replayEvidenceSegmentsV2(
      JSON.parse(document) as JcsJsonValue,
      [segment],
      replayer,
    );
    if (!replayed.ok) {
      return replayed.reason === "unsupported_format" ? "unsupported_format" : "replay_failed";
    }
    document = replayed.canonicalDocument;
    if (index === from - 1) atFrom = document;
    previous = segment;
  }
  return { from: atFrom, to: document };
}

/**
 * The replayer and revision 0 of the record's step format, from its first
 * segment: the formats a segment may name (EVIDENCE_TRANSACTION_FORMATS),
 * v1 over document v1 and v3 over document v3. The start check then ties
 * the first segment to that revision 0; a work of another version is a
 * `record_break`, never a guess.
 */
function replayFor<TV1, TV3>(
  replayers: CompareDeps<TV1, TV3>["replayers"],
  first: EvidenceSegment,
  next: NextSegment,
  from: number,
  to: number,
): Promise<Texts> {
  const format = first.captureContext.transactionFormat;
  if (format === EDIT_STEP_FORMAT_V1 && replayers.v1.transactionFormat === format) {
    return replayTo(replayers.v1, REVISION_ZERO_JCS, first, next, from, to);
  }
  if (format === EDIT_STEP_FORMAT_V3 && replayers.v3?.transactionFormat === format) {
    return replayTo(replayers.v3, REVISION_ZERO_V3_JCS, first, next, from, to);
  }
  return Promise.resolve<Texts>("unsupported_format");
}

/**
 * The difference between revision `from` and revision `to` (from < to) of
 * the work `documentId`, by blocks. Input that cannot be a pair of versions
 * is `invalid_input` before any read; a document id that cannot exist and a
 * revision beyond the record (after the submission cut too) are `not_found`
 * after access, as for a work that does not exist. Every failure is whole.
 */
export async function compareWorkVersions<TV1, TV3>(
  deps: CompareDeps<TV1, TV3>,
  documentId: string,
  from: number,
  to: number,
): Promise<CompareResult> {
  if (!isRevision(from) || !isRevision(to) || from >= to) return { status: "invalid_input" };
  if (!isReplayDocumentId(documentId)) return { status: "not_found" };

  // Access first: a reader who may not see the work learns nothing of its size.
  let source;
  try {
    source = await deps.source.readSource(documentId);
  } catch {
    return unavailable("source_unavailable");
  }
  if (source.status === "not_found" || source.status === "unauthenticated") {
    return { status: source.status };
  }
  if (source.status !== "found") return unavailable("source_unavailable");
  const hashes = source.segmentHashes;
  if (to > hashes.length) return { status: "not_found" };
  if (to > MAX_COMPARE_SEGMENTS) return { status: "too_large" };

  const { institutionId, evidencePackageId } = source;
  let readBytes = 0;
  const next: NextSegment = async (index) => {
    let stored;
    try {
      stored = await deps.payloads.readImmutable({
        institutionId,
        evidencePackageId,
        segmentHash: hashes[index] as string,
      });
    } catch {
      return "payload_unavailable";
    }
    if (stored.status === "not_found") return "payload_missing";
    if (stored.status !== "found") return "payload_unavailable";
    readBytes += stored.bytes.byteLength;
    if (readBytes > MAX_COMPARE_READ_BYTES) return "too_large";
    // Own copy: the bytes checked are the bytes replayed.
    const verified = await verifyCanonicalEvidencePayloadV2(new Uint8Array(stored.bytes));
    if (!verified.ok) return "invalid_segment";
    if (
      verified.sha256 !== hashes[index] ||
      verified.segment.predecessorSegmentHash !== (index === 0 ? null : hashes[index - 1]) ||
      verified.segment.documentId !== documentId
    ) {
      return "segment_mismatch";
    }
    return verified.segment;
  };

  const first = await next(0);
  const texts =
    typeof first === "string" ? first : await replayFor(deps.replayers, first, next, from, to);
  if (texts === "too_large") return { status: "too_large" };
  if (typeof texts === "string") return unavailable(texts);
  const before = blocksOf(texts.from);
  const after = blocksOf(texts.to);
  if (before === null || after === null) return unavailable("document_unreadable");
  if (before.length > MAX_COMPARE_BLOCKS || after.length > MAX_COMPARE_BLOCKS) {
    return { status: "too_large" };
  }
  return { status: "ok", from, to, blocks: diffBlocks(before, after) };
}
