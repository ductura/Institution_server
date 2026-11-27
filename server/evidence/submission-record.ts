import { createEditStepsV1Replayer } from "../external/storage/edit-steps-v1-replayer.ts";
import {
  createEditStepsV2Replayer,
  createEditStepsV3Replayer,
} from "../external/storage/edit-steps-v2-replayer.ts";
import type { EvidenceReconstructionOutcome } from "./evidence-reconstruction.ts";
import {
  reconstructSheetSubmission,
  reconstructSlidesSubmission,
  reconstructSubmission,
  type SubmissionRecord,
} from "./submission-reconstruction.ts";
import { consoleLog, type Log } from "./ingest-http.ts";
import { checkSheetSubmission } from "./sheet/index.ts";
import { isEvidencePackageId, isSha256Hex } from "../application/ports/evidence-ingest.ts";
import { isInstitutionId } from "../domain/evidence/object-key.ts";
import {
  bindPayloadReader,
  type InstitutionEvidencePayloadReader,
} from "../application/ports/evidence-reconstruction.ts";
import { DOCUMENT_SCHEMA_VERSION } from "../domain/document/schema.ts";
import { isEvidenceDomainId, isReceiptPrincipalId } from "../domain/forensics/evidence-receipt.ts";
import type { EvidenceDomainKey } from "../domain/forensics/evidence-receipt-verifier.ts";
import type { WithActor } from "../database/with-actor.ts";

import { readEvidenceDomainKeys } from "./evidence-domain-keys.ts";

/**
 * B-12 step 4b1 (docs/BACKEND.md 4.6; contract on #385): the record of a
 * submission request and the receipt keys of its domain, read in one
 * withActor transaction, then the reconstruction outside it, so no lock or
 * transaction is held while payloads are read from storage. Every fault is a
 * closed code; nothing from the record or the request reaches a message.
 */

export type SubmissionRecordFault =
  "record_failed" | "record_malformed" | "record_unavailable" | "domain_keys_unavailable";

export type SubmissionReconstruction =
  | {
      status: "reconstructed";
      record: SubmissionRecord;
      outcome: EvidenceReconstructionOutcome;
      /** The kind of the work the record belongs to (SRV-V14-SHEET-SUBMIT). */
      documentKind: SubmittedKind;
    }
  | { status: "unauthenticated" | "not_found" }
  | { status: "unavailable"; stage: "record"; code: SubmissionRecordFault };

/** Kinds whose submission this reader knows; every other kind keeps the text path. */
export type SubmittedKind = "text" | "slides" | "spreadsheet";

export type SubmissionRecordDependencies = {
  withActor: WithActor;
  /**
   * Codes only. The route passes its own log through the same object it hands
   * to the submission, so the mark "calculation aligned" of a spreadsheet work
   * reaches the log without any new column or wire field.
   */
  log?: Log;
  /** The storage domains (`evidencePayloadReader()`); bound here to the record's institution. */
  payloads: InstitutionEvidencePayloadReader;
};

const RECORD_SQL = `SELECT outcome, institution_id, evidence_package_id, evidence_domain_id, document_id, principal_id,
       revision, content_hash, head_segment_hash, segment_count, segments
  FROM app.read_submission_record($1::uuid)`;

// Under RLS the session sees only its own institution's own documents; the
// kind is written once, when the work starts, and never updated.
const KIND_SQL = "SELECT document_kind FROM evidence.document WHERE id = $1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RecordRow = Record<
  | "outcome"
  | "institution_id"
  | "evidence_package_id"
  | "evidence_domain_id"
  | "document_id"
  | "principal_id"
  | "revision"
  | "content_hash"
  | "head_segment_hash"
  | "segment_count"
  | "segments",
  unknown
>;

/** A bigint column as the driver gives it (text), or a number, from 1; null for anything else. */
function positive(value: unknown): number | null {
  const n = typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One listed segment, exactly the three keys the RPC builds; null for any other form. */
function listedSegment(value: unknown): SubmissionRecord["segments"][number] | null {
  if (!plain(value) || Object.keys(value).sort().join() !== "receiptPayload,segmentHash,signature")
    return null;
  const { segmentHash, receiptPayload, signature } = value;
  if (!isSha256Hex(segmentHash) || typeof receiptPayload !== "string") return null;
  if (signature === null) return { segmentHash, receipt: null };
  return plain(signature) ? { segmentHash, receipt: { receiptPayload, signature } } : null;
}

/** The `found` row as a record, or null when any field has another form. */
function recordFrom(row: RecordRow): SubmissionRecord | null {
  const revision = positive(row.revision);
  const segmentCount = positive(row.segment_count);
  const segments = Array.isArray(row.segments) ? row.segments.map(listedSegment) : null;
  if (
    !isInstitutionId(row.institution_id) ||
    !isEvidencePackageId(row.evidence_package_id) ||
    !isEvidenceDomainId(row.evidence_domain_id) ||
    typeof row.document_id !== "string" ||
    row.document_id === "" ||
    !isReceiptPrincipalId(row.principal_id) ||
    revision === null ||
    !isSha256Hex(row.content_hash) ||
    !isSha256Hex(row.head_segment_hash) ||
    segmentCount === null ||
    segments === null ||
    segments.length !== segmentCount ||
    !segments.every((segment) => segment !== null)
  ) {
    return null;
  }
  return {
    institutionId: row.institution_id,
    evidencePackageId: row.evidence_package_id,
    evidenceDomainId: row.evidence_domain_id,
    documentId: row.document_id,
    principalId: row.principal_id,
    revision,
    contentHash: row.content_hash,
    head: { segmentHash: row.head_segment_hash, segmentCount },
    segments: segments as SubmissionRecord["segments"],
  };
}

type Read =
  | {
      status: "found";
      record: SubmissionRecord;
      keys: EvidenceDomainKey[];
      documentKind: SubmittedKind;
    }
  | Exclude<SubmissionReconstruction, { status: "reconstructed" }>;

async function readRecord(
  withActor: WithActor,
  token: string | null,
  submissionRequestId: string,
): Promise<Read> {
  try {
    return await withActor(token, async (tx): Promise<Read> => {
      const { rows } = await tx.query<RecordRow>(RECORD_SQL, [submissionRequestId]);
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row?.outcome === "unauthenticated" || row?.outcome === "not_found")
        return { status: row.outcome };
      if (row?.outcome === "unavailable")
        return { status: "unavailable", stage: "record", code: "record_unavailable" };
      const record = row?.outcome === "found" ? recordFrom(row) : null;
      if (record === null)
        return { status: "unavailable", stage: "record", code: "record_malformed" };
      const keys = await readEvidenceDomainKeys(tx, record.evidenceDomainId);
      if (keys.status !== "ok")
        return { status: "unavailable", stage: "record", code: "domain_keys_unavailable" };
      // Exactly one row for a document the record names; anything else is no record.
      const kindRows = await tx.query<Record<"document_kind", unknown>>(KIND_SQL, [
        record.documentId,
      ]);
      if (kindRows.rows.length !== 1)
        return { status: "unavailable", stage: "record", code: "record_malformed" };
      const stored = kindRows.rows[0]?.document_kind;
      const documentKind: SubmittedKind =
        stored === "spreadsheet" || stored === "slides" ? stored : "text";
      return { status: "found", record, keys: keys.keys, documentKind };
    });
  } catch {
    return { status: "unavailable", stage: "record", code: "record_failed" };
  }
}

/**
 * The reconstruction of the revision a submission request names, for the
 * session behind `token` only. The request id comes from the server's own
 * `request_submission` answer; a value that is not a UUID is `not_found`.
 */
export async function reconstructSubmissionRecord(
  dependencies: SubmissionRecordDependencies,
  token: string | null,
  submissionRequestId: string,
): Promise<SubmissionReconstruction> {
  if (!UUID.test(submissionRequestId)) return { status: "not_found" };
  const read = await readRecord(dependencies.withActor, token, submissionRequestId);
  if (read.status !== "found") return read;
  const outcome = await reconstructRecordedSubmission(
    {
      payloads: dependencies.payloads,
      keys: read.keys,
      ...(dependencies.log ? { log: dependencies.log } : {}),
    },
    read.record,
    read.documentKind,
  );
  return { status: "reconstructed", record: read.record, outcome, documentKind: read.documentKind };
}

/**
 * The reconstruction of an already read record, by the kind of its work. Used
 * by the submission itself and by the worker that reconstructs a recorded
 * submission once more (F4-PM2-R01); the same checks, the same outcome.
 */
export async function reconstructRecordedSubmission(
  dependencies: {
    payloads: InstitutionEvidencePayloadReader;
    keys: EvidenceDomainKey[];
    log?: Log;
  },
  record: SubmissionRecord,
  documentKind: SubmittedKind,
): Promise<EvidenceReconstructionOutcome> {
  const payloads = bindPayloadReader(dependencies.payloads, record.institutionId);
  if (documentKind === "spreadsheet") {
    const sheet = await reconstructSheetSubmission({ payloads, keys: dependencies.keys }, record);
    let outcome = sheet.outcome;
    if (outcome.status === "match" || outcome.status === "match_across_gaps") {
      const check = checkSheetSubmission(sheet.document);
      // A document the validator refuses never lets a submission through.
      if (check.status === "invalid")
        outcome = { status: "mismatch", reason: "target_mismatch", index: null };
      else if (outcome.status === "match")
        (dependencies.log ?? consoleLog)("submission", "calculation", check.status);
    }
    return outcome;
  }
  if (documentKind === "slides") {
    return reconstructSlidesSubmission({ payloads, keys: dependencies.keys }, record);
  }
  return reconstructSubmission(
    {
      payloads,
      replayers: {
        v1: createEditStepsV1Replayer(),
        v2: createEditStepsV2Replayer(),
        v3: createEditStepsV3Replayer(),
      },
      keys: dependencies.keys,
    },
    record,
    // Until the record carries the document's version (DB step 1, contract
    // §7), every submitted document is v1.
    DOCUMENT_SCHEMA_VERSION,
  );
}
