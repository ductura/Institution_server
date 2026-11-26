import type { InstitutionEvidencePayloadReader } from "../application/ports/evidence-reconstruction.ts";
import { isEvidenceDomainId } from "../domain/index.ts";
import type { EvidenceDomainKey } from "../domain/forensics/evidence-receipt-verifier.ts";

import { decideSubmission } from "./submission-decision.ts";
import {
  reconstructRecordedSubmission,
  recordFrom,
  type RecordRow,
  type SubmittedKind,
} from "./submission-record.ts";
import type { SubmissionRecord } from "./submission-reconstruction.ts";

/**
 * F4-PM2-R01 (Ductus#2059): the worker's second reconstruction of a recorded
 * submission. The submission route stays synchronous; afterwards the worker
 * (ductus_worker, the domain of its own configuration) lists the submissions
 * without a verdict, reads the record of each, reconstructs the revision with
 * the very same checks as the route and hands the database the hash it got.
 * The database, not the worker, says `verified` or `mismatch`, by comparing
 * that hash with the one the submission was recorded with. An outage (storage,
 * keys, record) keeps no verdict, so the submission is tried again in a later
 * pass. Counts only leave this module: no id, text or hash.
 */

/** One statement on the worker's connection, as the checkpoint store takes it. */
export type VerdictQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: readonly unknown[] }>;

export type VerdictKeysRead =
  { status: "ok"; keys: EvidenceDomainKey[] } | { status: "unavailable"; reason: string };

export type SubmissionVerdictDeps = {
  query: VerdictQuery;
  evidenceDomainId: string;
  payloads: InstitutionEvidencePayloadReader;
  /** The receipt keys of the domain (`readReceiptKeys` over the worker's pool). */
  readKeys: (evidenceDomainId: string) => Promise<VerdictKeysRead>;
  /** Submissions per pass, 1 to 1000. */
  batchLimit?: number;
};

export type SubmissionVerdictPass = {
  listed: number;
  verified: number;
  mismatch: number;
  /** Left for a later pass: an outage or a record the worker cannot take whole. */
  unavailable: number;
};

const LIST_SQL =
  "SELECT submission_id FROM app.worker_submissions_to_reconstruct($1::uuid, $2::integer)";
const RECORD_SQL = `SELECT outcome, institution_id, evidence_package_id, evidence_domain_id, document_id, principal_id,
       revision, content_hash, head_segment_hash, segment_count, segments, document_kind
  FROM app.worker_submission_record($1::uuid, $2::uuid)`;
const KEEP_SQL =
  "SELECT app.worker_record_submission_reconstruction($1::uuid, $2::uuid, $3) AS outcome";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type ReadRecord =
  { status: "found"; record: SubmissionRecord; kind: SubmittedKind } | { status: "unavailable" };

async function readRecord(deps: SubmissionVerdictDeps, submissionId: string): Promise<ReadRecord> {
  let rows: readonly unknown[];
  try {
    rows = (await deps.query(RECORD_SQL, [deps.evidenceDomainId, submissionId])).rows;
  } catch {
    return { status: "unavailable" };
  }
  const row = rows.length === 1 ? (rows[0] as RecordRow & { document_kind?: unknown }) : undefined;
  if (row === undefined || row.outcome !== "found") return { status: "unavailable" };
  const record = recordFrom(row);
  if (record === null || (row.document_kind !== "text" && row.document_kind !== "spreadsheet"))
    return { status: "unavailable" };
  return { status: "found", record, kind: row.document_kind };
}

/** One pass over the submissions without a verdict. Never throws: a fault is a count. */
export async function runSubmissionVerdictPass(
  deps: SubmissionVerdictDeps,
): Promise<SubmissionVerdictPass> {
  const pass: SubmissionVerdictPass = { listed: 0, verified: 0, mismatch: 0, unavailable: 0 };
  const limit = deps.batchLimit ?? 100;
  if (
    !isEvidenceDomainId(deps.evidenceDomainId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new RangeError("submissionVerdict: invalid configuration");
  let ids: string[];
  try {
    const { rows } = await deps.query(LIST_SQL, [deps.evidenceDomainId, limit]);
    ids = rows
      .map((row) => (row as { submission_id?: unknown }).submission_id)
      .filter((id): id is string => typeof id === "string" && UUID.test(id));
    if (ids.length !== rows.length) return pass; // a row of another shape: nothing is trusted
  } catch {
    return pass;
  }
  pass.listed = ids.length;
  if (ids.length === 0) return pass;
  const keys = await deps.readKeys(deps.evidenceDomainId).catch(() => null);
  if (keys === null || keys.status !== "ok") {
    pass.unavailable = ids.length;
    return pass;
  }
  for (const id of ids) {
    const read = await readRecord(deps, id);
    if (read.status !== "found") {
      pass.unavailable += 1;
      continue;
    }
    let hash: string | null;
    try {
      const outcome = await reconstructRecordedSubmission(
        { payloads: deps.payloads, keys: keys.keys, log: () => undefined },
        read.record,
        read.kind,
      );
      const decision = decideSubmission(outcome);
      if (decision.decision === "retry") {
        pass.unavailable += 1;
        continue;
      }
      hash = decision.decision === "submit" ? decision.artifactSha256 : null;
    } catch {
      pass.unavailable += 1;
      continue;
    }
    try {
      const { rows } = await deps.query(KEEP_SQL, [deps.evidenceDomainId, id, hash]);
      const outcome = rows.length === 1 ? (rows[0] as { outcome?: unknown }).outcome : undefined;
      if (outcome === "verified") pass.verified += 1;
      else if (outcome === "mismatch") pass.mismatch += 1;
      else if (outcome !== "exists") pass.unavailable += 1;
    } catch {
      pass.unavailable += 1;
    }
  }
  return pass;
}
