// One page of the replay of a document (DAN-818, VS-1 narrow cut, step 4).
// Port of Ductus src/application/evidence/replay-reader.ts at 333e163 (DAN-344,
// route R3; DAN-537 pin), without a change of logic.
//
// The page holds the exact stored bytes of the segments from index `from` in
// chain order, each checked here: canonical, under its listed hash, linked to
// the listed segment before it and of the document asked for. The reader
// checks them again and replays them; the server runs no step (B-12 on the
// server is DAN-819). A later page is read only from the record that ends at
// the head the first page reported: one that has grown is read up to it, one
// that no longer holds it is `record_changed`. Who asks reaches this code only
// through `source`, so the owner and the teacher of the same stored state get
// the same bytes (PRODUCT §5 rule 5). Every failure is whole, never a partial
// page; `reason` is a fixed code for the server log.
import type { ReplayHead, ReplaySource } from "../database/index.ts";
import {
  canonicalizeJcs,
  REVISION_ZERO_JCS,
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_JCS,
  REVISION_ZERO_V2_SHA256,
  REVISION_ZERO_V3_JCS,
  REVISION_ZERO_V3_SHA256,
  sha256WebCrypto,
  verifyCanonicalEvidencePayloadV2,
  type VerifiedEvidencePayloadV2,
} from "../domain/index.ts";
import type { InstitutionEvidencePayloadReader } from "../external/storage/index.ts";

export const REPLAY_FORMAT = "ductus-evidence-replay-v1";
/**
 * Bytes per page: the segments, plus MAX_REPLAY_CHECKPOINT_BYTES for every
 * checkpoint text the page asks for, so the texts are counted before they
 * are read. A page always holds at least one segment.
 */
export const MAX_REPLAY_PAGE_BYTES = 8 * 1024 * 1024;
/** The largest checkpoint text (evidence.document_checkpoint); a longer one is no checkpoint. */
export const MAX_REPLAY_CHECKPOINT_BYTES = 2 * 1024 * 1024;
/** Segments per page, which also bounds the checkpoint hashes one page asks for. */
export const MAX_REPLAY_PAGE_SEGMENTS = 256;
const DOCUMENT_ID_MAX = 256;
// C0, DEL and C1 (Ductus src/domain/collaboration isDocumentId).
const CONTROL = /\p{Cc}/u;

/**
 * Revision 0 of each document version, by its hash (SRV-33C): fixed bytes the
 * database writes from a fixed function, the same for every work of that
 * version, so a work of document v2 or v3 replays from its own revision 0
 * exactly as a v1 work does, and no checkpoint is read for it.
 */
const REVISION_ZEROS: ReadonlyMap<string, string> = new Map([
  [REVISION_ZERO_SHA256, REVISION_ZERO_JCS],
  [REVISION_ZERO_V2_SHA256, REVISION_ZERO_V2_JCS],
  [REVISION_ZERO_V3_SHA256, REVISION_ZERO_V3_JCS],
]);

export type ReplayReaderDeps = {
  /** Already bound to the requesting session; decides access and lists the record. */
  readonly source: ReplaySource;
  /** Storage of every institution; bound here to the institution the source names. */
  readonly payloads: InstitutionEvidencePayloadReader;
};

export type ReplayPage = {
  replayFormat: typeof REPLAY_FORMAT;
  segmentCount: number;
  head: ReplayHead | null;
  from: number;
  next: number | null;
  /** Only on the first page: the document before the first change. */
  startDocument: string | null;
  segments: string[];
  /** Per chain break on this page: the checkpoint the replay resumes from, when one has that hash. */
  resumeDocuments: Record<string, string>;
};

export type ReplayUnavailableReason =
  | "source_unavailable"
  | "payload_missing"
  | "payload_unavailable"
  | "invalid_segment"
  | "segment_mismatch"
  | "checkpoints_unavailable"
  | "start_missing";

export type ReplayReadResult =
  | { status: "ok"; body: string }
  | { status: "not_found" | "unauthenticated" }
  /** The record no longer ends at the head the pages are pinned to; start again from the first page. */
  | { status: "record_changed" }
  | { status: "unavailable"; reason: ReplayUnavailableReason };

const unavailable = (reason: ReplayUnavailableReason): ReplayReadResult => ({
  status: "unavailable",
  reason,
});

/**
 * A document id that can exist: 1 to 256 code points, trimmed, no control
 * character. Stricter than or equal to the SQL check of the replay RPCs, so
 * an id refused here is one the database would answer as not found too.
 */
export function isReplayDocumentId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = [...value].length;
  return length >= 1 && length <= DOCUMENT_ID_MAX && !CONTROL.test(value);
}

/** Whether `listing` still holds `head` at its place: the whole record up to it, by the chain of hashes. */
function holds(listing: readonly string[], head: ReplayHead): boolean {
  const count = head.segmentCount;
  return (
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= listing.length &&
    listing[count - 1] === head.segmentHash
  );
}

/** The source read once more; access is decided again on every read. */
async function listing(source: ReplaySource, documentId: string) {
  let result;
  try {
    result = await source.readSource(documentId);
  } catch {
    return unavailable("source_unavailable");
  }
  if (result.status === "not_found") return { status: "not_found" } as const;
  if (result.status === "unauthenticated") return { status: "unauthenticated" } as const;
  if (result.status !== "found") return unavailable("source_unavailable");
  return result;
}

/**
 * `pin` is null for the first page and the head that page reported for every
 * later one; any other pairing is answered like an index that does not exist.
 */
export async function readReplayPage(
  deps: ReplayReaderDeps,
  documentId: string,
  from: number,
  pin: ReplayHead | null,
): Promise<ReplayReadResult> {
  // An id or index that cannot exist is answered like a document that does not.
  if (
    !isReplayDocumentId(documentId) ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    (from === 0) !== (pin === null)
  ) {
    return { status: "not_found" };
  }

  // Access first: a reader who may not see the document learns nothing of the pin.
  const source = await listing(deps.source, documentId);
  if (source.status !== "found") return source;
  if (pin !== null && !holds(source.segmentHashes, pin)) return { status: "record_changed" };
  const head = pin ?? source.head;

  const hashes = source.segmentHashes.slice(0, head?.segmentCount ?? 0);
  const page: ReplayPage = {
    replayFormat: REPLAY_FORMAT,
    segmentCount: hashes.length,
    head,
    from,
    next: null,
    startDocument: null,
    segments: [],
    resumeDocuments: {},
  };
  if (hashes.length === 0) {
    return from === 0 ? { status: "ok", body: canonicalizeJcs(page) } : { status: "not_found" };
  }
  if (from >= hashes.length) return { status: "not_found" };

  const { institutionId, evidencePackageId } = source;
  // The segment at `index`, held to the listing: its hash, its predecessor and its document.
  type Read = { verified: VerifiedEvidencePayloadV2; bytes: Uint8Array };
  async function read(index: number): Promise<Read | ReplayUnavailableReason> {
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
    // Own copy: the bytes checked are the bytes sent.
    const bytes = new Uint8Array(stored.bytes);
    const verified = await verifyCanonicalEvidencePayloadV2(bytes);
    if (!verified.ok) return "invalid_segment";
    if (
      verified.sha256 !== hashes[index] ||
      verified.segment.predecessorSegmentHash !== (index === 0 ? null : hashes[index - 1]) ||
      verified.segment.documentId !== documentId
    ) {
      return "segment_mismatch";
    }
    return { verified, bytes };
  }

  let previous: VerifiedEvidencePayloadV2 | null = null;
  if (from > 0) {
    // Only to see whether the page starts at a break; its bytes are not sent.
    const before = await read(from - 1);
    if (typeof before === "string") return unavailable(before);
    previous = before.verified;
  }
  const resumeHashes = new Set<string>();
  let pageBytes = 0;
  let index = from;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  // The document the first change applies to, asked for only on the first page.
  let start: string | null = null;
  while (index < hashes.length && page.segments.length < MAX_REPLAY_PAGE_SEGMENTS) {
    const current = await read(index);
    if (typeof current === "string") return unavailable(current);
    const { verified } = current;
    const initial = verified.segment.initialDocumentHash;
    const resumes = previous !== null && initial !== previous.segment.finalDocumentHash;
    // A checkpoint text this segment adds to the page; revision 0 is a fixed short text.
    const asks =
      !REVISION_ZEROS.has(initial) && (index === 0 || (resumes && !resumeHashes.has(initial)));
    const cost = verified.byteLength + (asks ? MAX_REPLAY_CHECKPOINT_BYTES : 0);
    if (page.segments.length > 0 && pageBytes + cost > MAX_REPLAY_PAGE_BYTES) break;
    // Verified canonical, so the bytes are valid UTF-8 and this text encodes back to them.
    page.segments.push(decoder.decode(current.bytes));
    pageBytes += cost;
    if (resumes) resumeHashes.add(initial);
    if (index === 0) start = initial;
    previous = verified;
    index++;
  }
  page.next = index < hashes.length ? index : null;

  // Revision 0 is the same bytes for every work of its version; no checkpoint is read for it.
  if (start !== null) page.startDocument = REVISION_ZEROS.get(start) ?? null;
  for (const [hash, text] of REVISION_ZEROS) {
    if (resumeHashes.delete(hash)) page.resumeDocuments[hash] = text;
  }
  const wanted = new Set(resumeHashes);
  if (start !== null && page.startDocument === null) wanted.add(start);
  if (wanted.size > 0) {
    let checkpoints;
    try {
      checkpoints = await deps.source.readCheckpoints(documentId, [...wanted].sort());
    } catch {
      return unavailable("checkpoints_unavailable");
    }
    if (checkpoints.status === "unauthenticated") return { status: "unauthenticated" };
    if (checkpoints.status !== "found") return unavailable("checkpoints_unavailable");
    let missing = false;
    for (const hash of wanted) {
      const text = checkpoints.texts.get(hash);
      // Only text within the reserved size that hashes to the hash it was asked for.
      if (
        text === undefined ||
        encoder.encode(text).byteLength > MAX_REPLAY_CHECKPOINT_BYTES ||
        (await sha256WebCrypto(text)) !== hash
      ) {
        missing = true;
        continue;
      }
      if (resumeHashes.has(hash)) page.resumeDocuments[hash] = text;
      if (hash === start && page.startDocument === null) page.startDocument = text;
    }
    if (missing && head !== null) {
      // The checkpoints are read in a transaction of their own: a submission
      // recorded since the listing hides the texts past its cut. A record that
      // no longer holds the head is a changed record, never a page that looks
      // like a break without a resume.
      const again = await listing(deps.source, documentId);
      if (again.status !== "found") return again;
      if (!holds(again.segmentHashes, head)) return { status: "record_changed" };
    }
  }
  // Without the document the first change applies to there is nothing to replay.
  if (start !== null && page.startDocument === null) return unavailable("start_missing");
  return { status: "ok", body: canonicalizeJcs(page) };
}
