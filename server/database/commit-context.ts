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

import {
  type DocumentSchemaVersion,
  readWorkVersion,
  type RevisionZeroKind,
  type WorkVersion,
} from "./evidence-work-version.ts";
import { count } from "./open-work.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

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
  /**
   * SRV-V14-SHEET-COMMIT: the kind of the work, from evidence.document
   * (fixed when the work starts). The commit branch of the kind judges the
   * snapshot and step format (text, slides or spreadsheet). The reader
   * always names it; a context without it is a text work (workKindOfContext).
   */
  documentKind?: RevisionZeroKind;
  /**
   * SRV-7F: the version of the work, from the server's record of its revision
   * 0 (contract v3 §7); every snapshot and step format is judged against it.
   * For a spreadsheet work it is the version of the spreadsheet model.
   */
  documentSchemaVersion: DocumentSchemaVersion;
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
// Under RLS the session sees only its own institution's own documents
// (evidence_document_read); the kind is written once and never updated.
const KIND_SQL = "SELECT document_kind FROM evidence.document WHERE id = $1";
// A Map, not an object: a value such as `__proto__` is no kind.
const KINDS = new Map<unknown, RevisionZeroKind>([
  ["text", "text"],
  // F4-V13-R04: app.open_student_work opens slides works (F4-V13-R01), and
  // the commit branch, replay and submission know them; the reader did not.
  ["slides", "slides"],
  ["spreadsheet", "spreadsheet"],
]);

type Work = { kind: RevisionZeroKind; version: WorkVersion };

/**
 * The kind and version of a work the context named, or null when there is not
 * exactly one row, the kind is none this reader knows, or revision 0 is not
 * one of that kind.
 */
async function readWork(tx: ActorTransaction, documentId: string): Promise<Work | null> {
  const { rows } = await tx.query<Row>(KIND_SQL, [documentId]);
  const kind = rows.length === 1 ? KINDS.get(rows[0]?.document_kind) : undefined;
  if (kind === undefined) return null;
  const version = await readWorkVersion(tx, documentId, kind);
  return version === null ? null : { kind, version };
}

type Row = Record<string, unknown>;

async function readContext(
  withActor: WithActor,
  token: string,
  documentId: string,
  clientTransactionId: string,
): Promise<EvidenceCommitContextResult> {
  let rows: Row[];
  // Read in the same transaction, and only for a document the context names.
  let work: Work | null = null;
  try {
    ({ rows, work } = await withActor(token, async (tx) => {
      const read = await tx.query<Row>(CONTEXT_SQL, [documentId, clientTransactionId]);
      const named = read.rows.length === 1 && read.rows[0]?.outcome === "ok";
      return { rows: read.rows, work: named ? await readWork(tx, documentId) : null };
    }));
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
    !(head === null || isSha256Hex(head)) ||
    work === null
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
      documentKind: work.kind,
      documentSchemaVersion: work.version.schemaVersion,
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
