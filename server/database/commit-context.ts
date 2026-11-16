// The commit context of POST /api/v1/evidence/commit (DAN-815, VS-1 narrow
// cut, step 3, part a1). Port of readEvidenceCommitContext from Ductus
// src/server/evidence/evidence-commit.ts at d52a92c3 (B-8 step 4c, BACKEND
// 4.13 t. 3.2), without a change of logic: the cheap check before any
// expensive work. It names the package, institution, domain and profile of
// the caller's own document under RLS, whether the transaction id is known,
// and the chain as it stands. Every row is checked before it leaves this
// folder; an unexpected one is a closed code, never a partial context.
import {
  isEvidenceDomainId,
  isEvidencePackageId,
  isInstitutionId,
  isSha256Hex,
} from "../domain/index.ts";

import { count } from "./open-work.ts";
import type { WithActor } from "./with-actor.ts";

export type EvidenceCommitState = {
  currentRevision: number;
  documentHash: string;
  headSegmentHash: string | null;
  lastSequenceTo: number;
};

export type EvidenceCommitContext = {
  evidencePackageId: string;
  institutionId: string;
  evidenceDomainId: string;
  evidenceProfileId: string;
  maxPayloadBytes: number;
  transactionKnown: boolean;
  /** The chain as the context read it, unlocked: the acceptance checks it again (F-099). */
  state: EvidenceCommitState;
};

export type EvidenceCommitContextResult =
  | { status: "ok"; context: EvidenceCommitContext }
  | { status: "unauthenticated" | "not_found" | "invalid" | "not_accepting" }
  | { status: "unavailable"; stage: "context"; code: "context_failed" | "context_malformed" };

/** The port the evidence area reads the context through; one call is one transaction. */
export type CommitContextReader = {
  readContext(
    token: string,
    documentId: string,
    clientTransactionId: string,
  ): Promise<EvidenceCommitContextResult>;
};

const CONTEXT_SQL = `SELECT outcome, evidence_package_id, institution_id, evidence_domain_id, evidence_profile_id,
       max_payload_bytes, transaction_known, current_revision, document_hash, head_segment_hash, last_sequence_to
  FROM app.evidence_commit_context($1, $2)`;
const REFUSALS = new Set(["unauthenticated", "not_found", "invalid", "not_accepting"]);

type Row = Record<string, unknown>;

async function readContext(
  withActor: WithActor,
  token: string,
  documentId: string,
  clientTransactionId: string,
): Promise<EvidenceCommitContextResult> {
  let rows: Row[];
  try {
    ({ rows } = await withActor(token, (tx) =>
      tx.query<Row>(CONTEXT_SQL, [documentId, clientTransactionId]),
    ));
  } catch {
    return { status: "unavailable", stage: "context", code: "context_failed" };
  }
  const malformed = { status: "unavailable", stage: "context", code: "context_malformed" } as const;
  const row = rows.length === 1 ? rows[0] : undefined;
  if (typeof row?.outcome === "string" && REFUSALS.has(row.outcome)) {
    return { status: row.outcome } as EvidenceCommitContextResult;
  }
  if (
    row?.outcome !== "ok" ||
    !isEvidencePackageId(row.evidence_package_id) ||
    !isInstitutionId(row.institution_id) ||
    !isEvidenceDomainId(row.evidence_domain_id) ||
    typeof row.evidence_profile_id !== "string" ||
    row.evidence_profile_id === "" ||
    !Number.isSafeInteger(row.max_payload_bytes) ||
    Number(row.max_payload_bytes) < 1 ||
    typeof row.transaction_known !== "boolean"
  ) {
    return malformed;
  }
  const currentRevision = count(row.current_revision);
  const lastSequenceTo = count(row.last_sequence_to);
  const documentHash = row.document_hash;
  const head = row.head_segment_hash;
  if (
    currentRevision === null ||
    lastSequenceTo === null ||
    !isSha256Hex(documentHash) ||
    !(head === null || isSha256Hex(head))
  ) {
    return malformed;
  }
  return {
    status: "ok",
    context: {
      evidencePackageId: row.evidence_package_id,
      institutionId: row.institution_id,
      evidenceDomainId: row.evidence_domain_id,
      evidenceProfileId: row.evidence_profile_id,
      maxPayloadBytes: Number(row.max_payload_bytes),
      transactionKnown: row.transaction_known,
      state: { currentRevision, documentHash, headSegmentHash: head, lastSequenceTo },
    },
  };
}

/** A reader over `withActor`; the token is only presented, never a parameter. */
export function createCommitContextReader(withActor: WithActor): CommitContextReader {
  return {
    readContext: (token, documentId, clientTransactionId) =>
      readContext(withActor, token, documentId, clientTransactionId),
  };
}
