import type { EvidencePayloadReader } from "../application/ports/evidence-reconstruction.ts";
import {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_VERSION_V2,
  DOCUMENT_SCHEMA_VERSION_V3,
} from "../domain/document/schema.ts";
import {
  REVISION_ZERO_JCS,
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_JCS,
  REVISION_ZERO_V2_SHA256,
  REVISION_ZERO_V3_JCS,
  REVISION_ZERO_V3_SHA256,
} from "../domain/document/revision-zero.ts";
import {
  digestEvidenceReceiptPayloadV2,
  isEvidenceReceiptPayloadV2,
  isSignedEvidenceReceiptV2,
  type EvidenceReceiptPayloadV2,
} from "../domain/forensics/evidence-receipt.ts";
import {
  EVIDENCE_VERIFICATION_UNAVAILABLE,
  verifySignedEvidenceReceiptV2,
  type EvidenceDomainKey,
} from "../domain/forensics/evidence-receipt-verifier.ts";
import type { EvidenceStepReplayerV2 } from "../domain/forensics/evidence-replay-v2.ts";
import { verifyCanonicalEvidencePayloadV2 } from "../domain/forensics/evidence-chain-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "../domain/forensics/jcs.ts";
import {
  sheetRevisionZeroDocument,
  slidesRevisionZeroDocument,
  type SheetDocument,
} from "../domain/index.ts";

import { capturingSheetReplayer } from "./sheet/index.ts";
import { slidesStepReplayer } from "./slides/index.ts";
import {
  reconstructAndCompareEvidence,
  type EvidenceReceiptCheck,
  type EvidenceReconstructionOutcome,
} from "./evidence-reconstruction.ts";

/**
 * B-12 step 4b1 (docs/BACKEND.md 4.6, 4.10 t. 1 and 3; contract on #385):
 * the reconstruction of a submission request's revision over the stored
 * record, with receipts v2 checked by the full verifier under the registry
 * keys of the package's domain (owner decision P2).
 */

/** A receipt as the database keeps it: the exact payload text and the signature. */
export type StoredEvidenceReceiptV2 = { receiptPayload: string; signature: unknown };

/** What `app.read_submission_record` gives, cut at the requested revision. */
export type SubmissionRecord = {
  institutionId: string;
  evidencePackageId: string;
  evidenceDomainId: string;
  documentId: string;
  principalId: string;
  revision: number;
  /** `content_hash` of the requested revision: the target of the reconstruction. */
  contentHash: string;
  head: { segmentHash: string; segmentCount: number };
  segments: { segmentHash: string; receipt: StoredEvidenceReceiptV2 | null }[];
};

/**
 * Reasons that depend on the key registry or on the runtime, not on the
 * receipt: the check could not be made, so the outcome is `unavailable` and a
 * retry may succeed, never a verdict on the record. A receipt under a key the
 * registry does not hold is therefore never accepted, and never called broken.
 */
const NOT_CHECKED: ReadonlySet<string> = new Set([
  EVIDENCE_VERIFICATION_UNAVAILABLE,
  "key_unknown",
  "key_scope",
  "key_revoked",
  "key_not_valid",
]);

function isStoredReceipt(value: unknown): value is StoredEvidenceReceiptV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredEvidenceReceiptV2).receiptPayload === "string"
  );
}

/** The payload, only when the stored text is its own JCS form byte for byte. */
function storedPayload(text: string): EvidenceReceiptPayloadV2 | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isEvidenceReceiptPayloadV2(parsed) && canonicalizeJcs(parsed) === text ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Each receipt of the record: a valid v2 payload stored as its exact JCS, of
 * this package, domain, document and segment, continuing the receipt before it, by the author
 * of the request, at a revision no lower than the one before and no higher
 * than the request's, the last one exactly the request's; its signature
 * verified under a receipt key of the package's domain from the registry
 * (never from a signer), as the receipt of the commit it names.
 */
export function submissionReceiptCheck(
  record: SubmissionRecord,
  keys: readonly EvidenceDomainKey[],
): EvidenceReceiptCheck {
  let previousRevision = 0;
  return async ({ receipt, index, evidencePackageId, segmentSha256, previousReceiptId }) => {
    if (!isStoredReceipt(receipt)) return { status: "mismatch" };
    const payload = storedPayload(receipt.receiptPayload);
    if (payload === null) return { status: "mismatch" };
    const digest = await digestEvidenceReceiptPayloadV2(payload);
    const signed = { payload, payloadDigestSha256: digest.sha256, signature: receipt.signature };
    const last = index === record.segments.length - 1;
    if (
      !isSignedEvidenceReceiptV2(signed) ||
      payload.evidencePackageId !== evidencePackageId ||
      payload.evidenceDomainId !== record.evidenceDomainId ||
      payload.documentId !== record.documentId ||
      payload.segmentHash !== segmentSha256 ||
      payload.previousReceiptId !== previousReceiptId ||
      payload.principalId !== record.principalId ||
      payload.revision < previousRevision ||
      payload.revision > record.revision ||
      (last && payload.revision !== record.revision)
    ) {
      return { status: "mismatch" };
    }
    const verified = await verifySignedEvidenceReceiptV2(
      signed,
      {
        documentId: record.documentId,
        clientTransactionId: payload.clientTransactionId,
        revision: payload.revision,
        evidenceDomainId: record.evidenceDomainId,
      },
      keys,
    );
    if (verified.ok) {
      previousRevision = payload.revision;
      return { status: "verified", receiptId: payload.receiptId };
    }
    if (NOT_CHECKED.has(verified.reason)) return { status: "unavailable", reason: verified.reason };
    return verified.reason === "signature_invalid"
      ? { status: "signature_invalid" }
      : { status: "mismatch" };
  };
}

/**
 * Replays the record from revision 0 (the known-answer bytes, 4.10 t. 3,
 * never the snapshot table) and compares the result with the requested
 * revision's hash (4.10 t. 1: no comparison with the snapshot in the demo).
 * The payloads are read from the storage domain of the record's institution.
 *
 * The replayer and revision 0 are those of `documentSchemaVersion` (contract
 * §9.2; v3 from document-schema-v3 §8). Any other value, of any type, is `unavailable` with a closed code
 * before a payload is read: the check could not be made, never a verdict. A
 * segment of the other format is refused by the replay as a mismatch.
 *
 * Each replayer reads the one step format a work of its version records
 * (`evidenceTransactionFormatOfWork`, v4 §9 t. 9): `v1` and `v2` read
 * `ductus-edit-steps-v1`, `v2` over document v2
 * (`createEditStepsV1OnV2Replayer`, SRV-33C), and `v3` reads `-v3`. Every
 * segment's recorded format is compared with the replayer's, so a segment of
 * any other format is refused, never read by a reader it was not written for.
 */
export function reconstructSubmission<TV1, TV2, TV3>(
  dependencies: {
    payloads: EvidencePayloadReader;
    replayers: {
      v1: EvidenceStepReplayerV2<TV1>;
      v2: EvidenceStepReplayerV2<TV2>;
      v3: EvidenceStepReplayerV2<TV3>;
    };
    keys: readonly EvidenceDomainKey[];
  },
  record: SubmissionRecord,
  documentSchemaVersion: unknown,
): Promise<EvidenceReconstructionOutcome> {
  if (documentSchemaVersion === DOCUMENT_SCHEMA_VERSION) {
    return reconstructWith(dependencies.replayers.v1, REVISION_ZERO_JCS, dependencies, record);
  }
  if (documentSchemaVersion === DOCUMENT_SCHEMA_VERSION_V2) {
    return reconstructWith(dependencies.replayers.v2, REVISION_ZERO_V2_JCS, dependencies, record);
  }
  if (documentSchemaVersion === DOCUMENT_SCHEMA_VERSION_V3) {
    // Contract document-schema-v3 §8: no work is v3 before its database step,
    // so this path is reached only once that step opens v3 works.
    return reconstructWith(dependencies.replayers.v3, REVISION_ZERO_V3_JCS, dependencies, record);
  }
  return Promise.resolve({
    status: "unavailable",
    stage: "verification",
    reason: "document_version_unknown",
  });
}

/** The document version each revision 0 the server writes names (document v2 §7 t. 3). */
const VERSION_OF_REVISION_ZERO: ReadonlyMap<string, number> = new Map([
  [REVISION_ZERO_SHA256, DOCUMENT_SCHEMA_VERSION],
  [REVISION_ZERO_V2_SHA256, DOCUMENT_SCHEMA_VERSION_V2],
  [REVISION_ZERO_V3_SHA256, DOCUMENT_SCHEMA_VERSION_V3],
]);

/**
 * SRV-33C: the reconstruction of a text work's submission, by what its record
 * holds rather than by a version assumed for every work. The record's first
 * segment names the document it starts from (`initialDocumentHash`, which the
 * acceptance tied to the work's revision 0 in the database) and the step
 * format it was recorded in (`captureContext.transactionFormat`). The revision
 * 0 it names gives the version, and so the revision 0 and the reader of that
 * version's one step format (`reconstructSubmission`); the replay then refuses
 * every segment recorded in another format. Nothing here is a verdict: the
 * reconstruction checks the same segment again, chain, receipts and all.
 *
 * The first segment is read once: the reconstruction gets the same result
 * (bytes, absence, outage or error), so the version is chosen from exactly the
 * bytes that are then verified. A record with no segment, a first segment that
 * cannot be read or verified, or one that starts at no revision 0 keeps the
 * v1 path as before, where the reconstruction reports what is wrong with it.
 */
export async function reconstructTextSubmission<TV1, TV2, TV3>(
  dependencies: Parameters<typeof reconstructSubmission<TV1, TV2, TV3>>[0],
  record: SubmissionRecord,
): Promise<EvidenceReconstructionOutcome> {
  const firstHash = record.segments[0]?.segmentHash;
  if (firstHash === undefined) {
    return reconstructSubmission(dependencies, record, DOCUMENT_SCHEMA_VERSION);
  }
  const first = dependencies.payloads.readImmutable({
    evidencePackageId: record.evidencePackageId,
    segmentHash: firstHash,
  });
  // Handled here and again by the reconstruction, which reports a failure.
  first.catch(() => undefined);
  const payloads: EvidencePayloadReader = {
    readImmutable: (input) =>
      input.evidencePackageId === record.evidencePackageId && input.segmentHash === firstHash
        ? first.then((read) =>
            read.status === "found" ? { status: "found", bytes: new Uint8Array(read.bytes) } : read,
          )
        : dependencies.payloads.readImmutable(input),
  };
  let version: number = DOCUMENT_SCHEMA_VERSION;
  const read = await first.catch(() => null);
  if (read?.status === "found") {
    const verified = await verifyCanonicalEvidencePayloadV2(new Uint8Array(read.bytes));
    if (verified.ok) {
      version = VERSION_OF_REVISION_ZERO.get(verified.segment.initialDocumentHash) ?? version;
    }
  }
  return reconstructSubmission({ ...dependencies, payloads }, record, version);
}

function reconstructWith<TDocument>(
  replayer: EvidenceStepReplayerV2<TDocument>,
  revisionZeroJcs: string,
  dependencies: { payloads: EvidencePayloadReader; keys: readonly EvidenceDomainKey[] },
  record: SubmissionRecord,
): Promise<EvidenceReconstructionOutcome> {
  return reconstructAndCompareEvidence(
    {
      chain: {
        readChain: async () => ({ status: "found", head: record.head, segments: record.segments }),
      },
      payloads: dependencies.payloads,
      replayer,
      receipts: submissionReceiptCheck(record, dependencies.keys),
    },
    {
      evidencePackageId: record.evidencePackageId,
      initialDocument: JSON.parse(revisionZeroJcs) as JcsJsonValue,
      expectedDocumentSha256: record.contentHash,
    },
  );
}

/**
 * SRV-V14-SHEET-SUBMIT: the same reconstruction for a work of kind
 * `spreadsheet`: revision 0 is the spreadsheet's, the steps are replayed with
 * the sheet step format (a step of another format is a mismatch), and the
 * document the record reproduces is returned with the outcome so it can be
 * checked. The document is only meaningful when the outcome is a match.
 */
export async function reconstructSheetSubmission(
  dependencies: { payloads: EvidencePayloadReader; keys: readonly EvidenceDomainKey[] },
  record: SubmissionRecord,
): Promise<{ outcome: EvidenceReconstructionOutcome; document: SheetDocument | null }> {
  const captured = capturingSheetReplayer();
  const outcome = await reconstructWith(
    captured.replayer,
    canonicalizeJcs(sheetRevisionZeroDocument() as unknown as JcsJsonValue),
    dependencies,
    record,
  );
  return { outcome, document: captured.last() };
}

/**
 * SRV-F4-V13-R02: the same reconstruction for a work of kind `slides`:
 * revision 0 is the deck's, the steps are replayed with the slide step format
 * (a step of another format is a mismatch). As for text, nothing but the
 * outcome is returned: the replay itself checks each event's hash.
 */
export function reconstructSlidesSubmission(
  dependencies: { payloads: EvidencePayloadReader; keys: readonly EvidenceDomainKey[] },
  record: SubmissionRecord,
): Promise<EvidenceReconstructionOutcome> {
  return reconstructWith(
    slidesStepReplayer,
    canonicalizeJcs(slidesRevisionZeroDocument() as unknown as JcsJsonValue),
    dependencies,
    record,
  );
}
