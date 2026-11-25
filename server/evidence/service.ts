// The commit preparation of POST /api/v1/evidence/commit (DAN-815, VS-1
// narrow cut, step 3, part b2). Port of Ductus
// src/server/evidence/evidence-commit-request.ts at d52a92c3 (B-8 step 4d,
// BACKEND 4.13 t. 3.1 to 3.5), without a change of logic. Nothing the client
// says about the segment is taken on trust: the descriptor, the segment hash
// and its size come from the received bytes, and the package, institution
// and profile from the database's context for the document. Each step runs
// only after the one before it passed.
import type {
  EvidenceCommitOutcome,
  EvidenceCommitSigning,
  EvidenceCommitter,
} from "../database/index.ts";
import {
  type EvidenceSegmentDescriptorV2,
  evidenceTransactionFormatOfWork,
  exceedsEvidenceSegmentLimit,
  isEvidenceSegmentDescriptorV2,
  isReceiptClientTransactionId,
  MAX_DOCUMENT_SNAPSHOT_BYTES,
  verifyCanonicalEvidencePayloadV2,
  verifyVersionedDocumentSnapshot,
} from "../domain/index.ts";
import type { EvidencePayloadLocator, EvidencePayloadStore } from "../external/storage/index.ts";

import { verifySlidesCommit, workKindOfContext } from "./slides/index.ts";

export type EvidenceCommitRequest = {
  documentId: string;
  clientTransactionId: string;
  baseRevision: number;
  /** Exact JCS bytes of one segment v2, as received. */
  segment: Uint8Array;
  /** Exact JCS bytes of the document after the segment's last event, as received. */
  document: Uint8Array;
};

export type EvidenceCommitRequestOutcome =
  | EvidenceCommitOutcome
  | { status: "unauthenticated" | "document_mismatch" }
  | {
      status: "unavailable";
      stage: "context" | "storage" | "repository";
      code:
        | "context_failed"
        | "context_malformed"
        | "storage_unavailable"
        | "storage_conflict"
        | "storage_refused"
        | "prepare_failed";
    };

export type EvidenceCommitDependencies = {
  committer: EvidenceCommitter;
  payloads: EvidencePayloadStore & EvidencePayloadLocator;
};

/** The service `http` commits through; it never throws. */
export type EvidenceService = {
  commit(
    token: string,
    request: EvidenceCommitRequest,
    signing?: EvidenceCommitSigning,
  ): Promise<EvidenceCommitRequestOutcome>;
};

const MAX_BASE_REVISION = Number.MAX_SAFE_INTEGER - 1;

async function prepareAndCommit(
  deps: EvidenceCommitDependencies,
  token: string,
  request: EvidenceCommitRequest,
  signing: EvidenceCommitSigning,
): Promise<EvidenceCommitRequestOutcome> {
  // t. 3.1: the form and the size limits, before any state is read.
  const { documentId, clientTransactionId, baseRevision, segment, document } = request;
  if (
    typeof documentId !== "string" ||
    !isReceiptClientTransactionId(clientTransactionId) ||
    !Number.isSafeInteger(baseRevision) ||
    baseRevision < 0 ||
    baseRevision > MAX_BASE_REVISION ||
    !(segment instanceof Uint8Array) ||
    !(document instanceof Uint8Array)
  ) {
    return { status: "invalid" };
  }
  if (
    exceedsEvidenceSegmentLimit(segment.byteLength) ||
    document.byteLength > MAX_DOCUMENT_SNAPSHOT_BYTES
  ) {
    return { status: "too_large" };
  }

  // t. 3.2: the context before any expensive work.
  const resolved = await deps.committer.readContext(token, documentId, clientTransactionId);
  if (resolved.status !== "ok") return resolved;
  const context = resolved.context;

  // t. 3.3: the segment, byte for byte, of this document and this package's profile.
  const verified = await verifyCanonicalEvidencePayloadV2(segment);
  if (!verified.ok) return { status: verified.reason };
  const s = verified.segment;
  if (s.documentId !== documentId || s.evidenceProfileId !== context.evidenceProfileId) {
    return { status: "invalid" };
  }
  if (verified.byteLength > context.maxPayloadBytes) return { status: "too_large" };
  // SRV-V13-EVIDENCE-SLAJD: the kind of the work decides the validator. A
  // slides work is judged by the slides validator and step format; a text work
  // takes the checks below, unchanged.
  const kind = workKindOfContext(context);
  if (kind === null) return { status: "invalid" };
  let snapshotText: string;
  if (kind === "slides") {
    const verdict = verifySlidesCommit({
      transactionFormat: s.captureContext.transactionFormat,
      document,
      finalDocumentHash: s.finalDocumentHash,
    });
    if (verdict.status !== "ok") return { status: verdict.status };
    snapshotText = verdict.text;
  } else {
    // SRV-7F, SRV-10E (contract v3 §5 t. 7, §7; v4 §9 t. 9): the step format is
    // the work's, judged against its revision 0: ductus-edit-steps-v1 on a v1 or
    // v2 work, -v3 only on a v3 work and -v4 only on a v4 work; none takes another.
    const stepFormat = evidenceTransactionFormatOfWork(context.documentSchemaVersion);
    if (stepFormat === null || s.captureContext.transactionFormat !== stepFormat) {
      return { status: "invalid" };
    }

    // t. 3.4: the snapshot is the document the segment ends in, of schema 1 to
    // 4, and of the work's own version (SRV-7F, SRV-10E): refused here, before
    // storage, as the database would refuse it at the end (document v2 §7 t. 4).
    const snapshot = await verifyVersionedDocumentSnapshot(document);
    if (!snapshot.ok) return { status: snapshot.reason };
    if (snapshot.document.schemaVersion !== context.documentSchemaVersion) {
      return { status: "invalid" };
    }
    if (snapshot.sha256 !== s.finalDocumentHash) return { status: "document_mismatch" };
    snapshotText = snapshot.text;
  }

  const descriptor: EvidenceSegmentDescriptorV2 = {
    evidencePackageId: context.evidencePackageId,
    documentId: s.documentId,
    sessionId: s.sessionId,
    segmentId: s.segmentId,
    evidenceSchema: s.evidenceSchema,
    canonicalization: s.canonicalization,
    hashAlgorithm: s.hashAlgorithm,
    evidenceProfileId: s.evidenceProfileId,
    sequenceFrom: s.sequenceFrom,
    sequenceTo: s.sequenceTo,
    eventCount: s.events.length,
    observedStartedAt: s.observedStartedAt,
    observedEndedAt: s.observedEndedAt,
    segmentHash: verified.sha256,
    predecessorSegmentHash: s.predecessorSegmentHash,
    payloadBytes: verified.byteLength,
  };
  if (!isEvidenceSegmentDescriptorV2(descriptor)) return { status: "invalid" };

  // F-099: what the acceptance would refuse for a new key is refused before
  // storage, in its order (t. 9 to 12), against the state the context read.
  // A known key stores nothing, so its retry goes on to its receipt.
  if (!context.transactionKnown) {
    const { state } = context;
    if (state.currentRevision !== baseRevision) return { status: "stale_base", state };
    if (s.predecessorSegmentHash !== state.headSegmentHash) {
      return { status: "chain_conflict", state };
    }
    if (s.sequenceFrom <= state.lastSequenceTo) return { status: "invalid" };
    if (
      s.sequenceFrom !== state.lastSequenceTo + 1 ||
      s.initialDocumentHash !== state.documentHash
    ) {
      return { status: "not_continuous", state };
    }
  }

  // t. 3.5: the object is written only under a key not known yet; a known key
  // names the object it already stored, so a retry writes nothing.
  const key = {
    institutionId: context.institutionId,
    evidencePackageId: context.evidencePackageId,
    segmentHash: verified.sha256,
  };
  let storageRef: string;
  if (context.transactionKnown) {
    const located = await deps.payloads.storageRefFor(key);
    if (located.status !== "ok") {
      return { status: "unavailable", stage: "storage", code: "storage_unavailable" };
    }
    storageRef = located.storageRef;
  } else {
    // Verified JCS bytes are valid UTF-8, so this decodes exactly them. The
    // route hands over a buffer it alone holds, so they are the bytes verified.
    const canonicalPayload = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      segment,
    );
    const stored = await deps.payloads.putImmutable({ ...key, canonicalPayload });
    if (stored.status === "unavailable") {
      return { status: "unavailable", stage: "storage", code: "storage_unavailable" };
    }
    // The key is the hash of verified bytes and the server's own package, so a
    // conflict or a refusal is a fault of the store, never of the client.
    if (stored.status === "conflict") {
      return { status: "unavailable", stage: "storage", code: "storage_conflict" };
    }
    if (stored.status !== "stored" && stored.status !== "existing") {
      return { status: "unavailable", stage: "storage", code: "storage_refused" };
    }
    storageRef = stored.storageRef;
  }

  // t. 3.6: one transaction, signed in it (part a2) or left to the worker (protocol 2).
  return deps.committer.commit(
    token,
    {
      context,
      documentId,
      clientTransactionId,
      baseRevision,
      initialDocumentHash: s.initialDocumentHash,
      finalDocumentHash: s.finalDocumentHash,
      descriptor,
      storageRef,
      snapshot: snapshotText,
    },
    signing,
  );
}

/** A service over the committer and storage `http` hands over. */
export function createEvidenceService(deps: EvidenceCommitDependencies): EvidenceService {
  return {
    // Never throws; a fault of the runtime is a closed code, never its message.
    async commit(token, request, signing = "inline") {
      try {
        return await prepareAndCommit(deps, token, request, signing);
      } catch {
        return { status: "unavailable", stage: "repository", code: "prepare_failed" };
      }
    },
  };
}
