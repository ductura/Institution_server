// The signed transaction of POST /api/v1/evidence/commit (DAN-815, VS-1 narrow
// cut, step 3, part a2). Port of Ductus src/server/evidence/evidence-commit.ts at
// d52a92c3 (B-8 step 4c, BACKEND 4.13 t. 3.2, 3.6, 4 and 7), without a change
// of logic. The context is the cheap check before any expensive work; the
// commit is one withActor transaction in which the acceptance RPC, the
// signature over its receipt and the RPC that attaches it either all happen
// or none does (ADR 2026-10-11, owner decision 6). A retry gets the stored
// receipt only after it verifies under a key of the domain read from the
// registry, and never a new signature. Every fault is a closed code, never a
// message. Deferred signing (protocol 2, DAN-518) is ported as it is and off
// unless the caller asks for it.
import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  type EvidenceReceiptPayloadV2,
  type EvidenceSegmentDescriptorV2,
  isEvidenceReceiptPayloadV2,
  isSha256Hex,
  isSignatureEnvelope,
  type Result,
  type SignatureEnvelope,
  type SignedEvidenceReceiptV2,
  verifySignedEvidenceReceiptV2,
} from "../domain/index.ts";

import {
  type CommitContextReader,
  createCommitContextReader,
  type EvidenceCommitContext,
  type EvidenceCommitState,
} from "./commit-context.ts";
import { count, receiptKeys } from "./open-work.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

/** The signing port as this folder uses it: `external/keys` provides it, `http` hands it over. */
export type ReceiptSigner = {
  sign(message: Uint8Array): Promise<Result<SignatureEnvelope>>;
};

/** Everything the commit needs; checked before this point, and again by the RPC. */
export type EvidenceCommitInput = {
  context: EvidenceCommitContext;
  documentId: string;
  clientTransactionId: string;
  baseRevision: number;
  initialDocumentHash: string;
  finalDocumentHash: string;
  descriptor: EvidenceSegmentDescriptorV2;
  storageRef: string;
  /** Exact JCS bytes of the document after the segment (4.10 t. 2). */
  snapshot: string;
};

export type EvidenceCommitFault =
  | "commit_failed"
  | "commit_rows"
  | "outcome_unknown"
  | "duplicate_pending"
  | "state_malformed"
  | "receipt_malformed"
  | "receipt_mismatch"
  | "domain_keys_unavailable"
  | "signing_failed"
  | "signature_unverified"
  | "attach_refused"
  | "stored_receipt_unverified";

export type EvidenceCommitOutcome =
  | { status: "committed" | "duplicate"; revision: number; signedReceipt: SignedEvidenceReceiptV2 }
  /** Deferred signing only: accepted, its receipt still `pending_signature`. */
  | { status: "committed_pending" | "duplicate_pending"; revision: number }
  | { status: "stale_base" | "chain_conflict" | "not_continuous"; state: EvidenceCommitState }
  | { status: "txid_reused" | "invalid" | "too_large" | "not_accepting" | "not_found" }
  | { status: "unavailable"; stage: "signing" | "repository"; code: EvidenceCommitFault };

/** `inline`: signed in the acceptance's transaction (protocol 1); `deferred`: by the worker (protocol 2). */
export type EvidenceCommitSigning = "inline" | "deferred";

/** The port the evidence area commits through; each call is one transaction. */
export type EvidenceCommitter = CommitContextReader & {
  commit(
    token: string,
    input: EvidenceCommitInput,
    signing?: EvidenceCommitSigning,
  ): Promise<EvidenceCommitOutcome>;
};

const COMMIT_SQL = `SELECT outcome, committed_revision, receipt_payload, receipt_id, signature,
       current_revision, document_hash, head_segment_hash, last_sequence_to
  FROM app.commit_evidence_segment($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`;
const ATTACH_SQL = "SELECT outcome FROM app.attach_receipt_signature($1::uuid, $2, $3::jsonb)";
type Row = Record<string, unknown>;
/** Thrown inside the transaction, so withActor rolls all of it back. */
class CommitFault extends Error {
  readonly stage: "signing" | "repository";
  readonly code: EvidenceCommitFault;
  constructor(stage: "signing" | "repository", code: EvidenceCommitFault) {
    super(code);
    this.stage = stage;
    this.code = code;
  }
}

function fault(stage: "signing" | "repository", code: EvidenceCommitFault): never {
  throw new CommitFault(stage, code);
}

function conflictState(row: Row): EvidenceCommitState {
  const currentRevision = count(row.current_revision);
  const lastSequenceTo = count(row.last_sequence_to);
  const documentHash = row.document_hash;
  const headSegmentHash = row.head_segment_hash;
  if (
    currentRevision === null ||
    lastSequenceTo === null ||
    !isSha256Hex(documentHash) ||
    !(headSegmentHash === null || isSha256Hex(headSegmentHash))
  ) {
    return fault("repository", "state_malformed");
  }
  return { currentRevision, documentHash, headSegmentHash, lastSequenceTo };
}

/** The signature in one fixed key order, so a duplicate repeats the bytes of the first answer. */
function envelope(value: unknown): SignatureEnvelope | null {
  if (!isSignatureEnvelope(value)) return null;
  const { algorithm, keyId, keyVersion, signatureEncoding, signatureBase64Url } = value;
  return { algorithm, keyId, keyVersion, signatureEncoding, signatureBase64Url };
}

/**
 * The receipt payload the RPC returned: a valid v2 payload whose JCS is the
 * returned text byte for byte, for this request's document, transaction,
 * package, domain, segment and the revision after its base.
 */
async function returnedReceipt(row: Row, input: EvidenceCommitInput) {
  let payload: EvidenceReceiptPayloadV2;
  let digest: Awaited<ReturnType<typeof digestEvidenceReceiptPayloadV2>>;
  try {
    const parsed: unknown =
      typeof row.receipt_payload === "string" ? JSON.parse(row.receipt_payload) : null;
    if (!isEvidenceReceiptPayloadV2(parsed) || canonicalizeJcs(parsed) !== row.receipt_payload) {
      throw new Error("receipt");
    }
    payload = parsed;
    digest = await digestEvidenceReceiptPayloadV2(payload);
  } catch {
    return fault("repository", "receipt_malformed");
  }
  const revision = input.baseRevision + 1;
  if (
    payload.documentId !== input.documentId ||
    payload.clientTransactionId !== input.clientTransactionId ||
    payload.segmentHash !== input.descriptor.segmentHash ||
    payload.segmentId !== input.descriptor.segmentId ||
    payload.evidencePackageId !== input.context.evidencePackageId ||
    payload.evidenceDomainId !== input.context.evidenceDomainId ||
    payload.revision !== revision ||
    count(row.committed_revision) !== revision ||
    row.receipt_id !== payload.receiptId
  ) {
    fault("repository", "receipt_mismatch");
  }
  return { payload, digest };
}

/** Verified only under a receipt key of the package's domain read from the registry. */
async function verifyUnderRegistry(
  tx: ActorTransaction,
  signedReceipt: SignedEvidenceReceiptV2,
  input: EvidenceCommitInput,
): Promise<boolean> {
  const keys = await receiptKeys(tx, input.context.evidenceDomainId);
  if (keys === null) fault("repository", "domain_keys_unavailable");
  const expected = {
    documentId: input.documentId,
    clientTransactionId: input.clientTransactionId,
    revision: input.baseRevision + 1,
    evidenceDomainId: input.context.evidenceDomainId,
  };
  return (await verifySignedEvidenceReceiptV2(signedReceipt, expected, keys)).ok;
}

async function signReserved(
  tx: ActorTransaction,
  signer: ReceiptSigner,
  row: Row,
  input: EvidenceCommitInput,
): Promise<EvidenceCommitOutcome> {
  const { payload, digest } = await returnedReceipt(row, input);
  let signature: SignatureEnvelope | null;
  try {
    // Our port answers a Result; a failure is the same fault as a throw.
    const signed = await signer.sign(digest.signingInput);
    signature = signed.ok ? envelope(signed.value) : null;
  } catch {
    return fault("signing", "signing_failed");
  }
  if (signature === null) return fault("signing", "signing_failed");
  const signedReceipt = { payload, payloadDigestSha256: digest.sha256, signature };
  if (!(await verifyUnderRegistry(tx, signedReceipt, input))) {
    fault("signing", "signature_unverified");
  }
  const attached = await tx.query<Row>(ATTACH_SQL, [
    payload.receiptId,
    digest.sha256,
    JSON.stringify(signature),
  ]);
  if (attached.rows.length !== 1 || attached.rows[0]?.outcome !== "signed") {
    fault("repository", "attach_refused");
  }
  return { status: "committed", revision: payload.revision, signedReceipt };
}

/** The stored receipt of a retry, rebuilt and verified; never signed again. */
async function storedReceipt(
  tx: ActorTransaction,
  row: Row,
  input: EvidenceCommitInput,
): Promise<EvidenceCommitOutcome> {
  const { payload, digest } = await returnedReceipt(row, input);
  const signature = envelope(row.signature);
  if (signature === null) return fault("repository", "stored_receipt_unverified");
  const signedReceipt = { payload, payloadDigestSha256: digest.sha256, signature };
  if (!(await verifyUnderRegistry(tx, signedReceipt, input))) {
    fault("repository", "stored_receipt_unverified");
  }
  return { status: "duplicate", revision: payload.revision, signedReceipt };
}

/** An acceptance whose receipt the worker signs; checked as any returned receipt, never signed here. */
async function pendingReceipt(
  row: Row,
  input: EvidenceCommitInput,
  status: "committed_pending" | "duplicate_pending",
): Promise<EvidenceCommitOutcome> {
  const { payload } = await returnedReceipt(row, input);
  // A pending receipt has no signature; one with a signature is no pending receipt.
  if (row.signature !== null && row.signature !== undefined) {
    fault("repository", "receipt_malformed");
  }
  return { status, revision: payload.revision };
}

async function runCommit(
  tx: ActorTransaction,
  signer: ReceiptSigner,
  input: EvidenceCommitInput,
  signing: EvidenceCommitSigning,
): Promise<EvidenceCommitOutcome> {
  const { rows } = await tx.query<Row>(COMMIT_SQL, [
    input.context.evidencePackageId,
    input.clientTransactionId,
    input.baseRevision,
    input.initialDocumentHash,
    input.finalDocumentHash,
    JSON.stringify(input.descriptor),
    input.descriptor.segmentHash,
    input.storageRef,
    input.snapshot,
  ]);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) return fault("repository", "commit_rows");
  // The closed mapping of 4.13 t. 4; an outcome not named here is never a success.
  switch (row.outcome) {
    case "reserved":
      return signing === "deferred"
        ? pendingReceipt(row, input, "committed_pending")
        : signReserved(tx, signer, row, input);
    case "duplicate_signed":
      return storedReceipt(tx, row, input);
    case "unauthorized":
      return { status: "not_found" };
    case "context_mismatch":
    case "invalid":
      return { status: "invalid" };
    case "idempotency_conflict":
      return { status: "txid_reused" };
    case "not_accepting":
    case "too_large":
      return { status: row.outcome };
    case "stale_base":
    case "chain_conflict":
    case "not_continuous":
      return { status: row.outcome, state: conflictState(row) };
    case "duplicate_pending":
      // Under inline signing it cannot exist in the demo (ADR decision 6); never signed here.
      return signing === "deferred"
        ? pendingReceipt(row, input, "duplicate_pending")
        : fault("repository", "duplicate_pending");
    default:
      return fault("repository", "outcome_unknown");
  }
}

/**
 * A committer over `withActor` and the receipt signer. A thrown fault, a
 * failed query or a failed COMMIT rolls back everything the RPC wrote, so
 * there is no revision, segment, snapshot or receipt without its signature.
 * The token is only presented to withActor, never a parameter of a statement.
 */
export function createEvidenceCommitter(
  withActor: WithActor,
  signer: ReceiptSigner,
): EvidenceCommitter {
  return {
    ...createCommitContextReader(withActor),
    async commit(token, input, signing = "inline") {
      try {
        return await withActor(token, (tx) => runCommit(tx, signer, input, signing));
      } catch (error) {
        return error instanceof CommitFault
          ? { status: "unavailable", stage: error.stage, code: error.code }
          : { status: "unavailable", stage: "repository", code: "commit_failed" };
      }
    },
  };
}
