// The student's work for one assignment (DAN-811, VS-1 narrow cut, step 2).
// Port of Ductus src/server/evidence/open-route.ts (open) and
// evidence-domain-keys.ts at 078c780, without a change of logic: every
// statement runs in one withActor transaction and every row is checked
// before it leaves this folder; the rows become camelCase only here.
import { isEvidenceDomainId, isSha256Hex } from "../domain/index.ts";

import type { ActorTransaction, WithActor } from "./with-actor.ts";

/** A public receipt key of the work's evidence domain, as the contract sends it. */
export type ReceiptKey = {
  algorithm: "Ed25519";
  keyId: string;
  keyVersion: string;
  encoding: "spki-der";
  keyBase64Url: string;
  evidenceDomainId: string;
  purpose: "receipt";
  validFrom: string;
  validTo: string | null;
  revokedAt: string | null;
};

export type OpenedWork = {
  documentId: string;
  evidenceProfileId: string;
  currentRevision: number;
  documentHash: string;
  headSegmentHash: string | null;
  lastSequenceTo: number;
  /** The snapshot of currentRevision as the database holds it (JCS text). */
  snapshot: string;
  receiptKeys: ReceiptKey[];
  submitted: boolean;
};

export type OpenWorkResult =
  | { status: "opened"; work: OpenedWork }
  | { status: "unauthenticated" | "not_found" | "not_accepting" | "not_started" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { status: "unavailable"; reason: string };

/** The port server/http opens a work through; one call is one transaction. */
export type WorkOpener = {
  openWork(token: string, assignmentId: string, start: boolean): Promise<OpenWorkResult>;
};

const OPEN_SQL = `SELECT outcome, document_id, evidence_profile_id, current_revision, document_hash,
       head_segment_hash, last_sequence_to, snapshot
  FROM app.open_student_work($1::uuid, $2::boolean)`;
// DAN-289 O2: whether the caller's own work for the assignment is submitted.
const SUBMITTED_SQL = "SELECT app.work_submitted($1::uuid) AS submitted";
// Under RLS the session sees only its own packages; the first one, as the open RPC picks it.
const DOMAIN_SQL = `SELECT evidence_domain_id::text AS evidence_domain_id FROM evidence.package
 WHERE document_id = $1 ORDER BY created_at, id LIMIT 1`;
// ISO 8601 in UTC with milliseconds, formatted by the database, never by a driver's time zone.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO})`;
const KEYS_SQL = `
SELECT key_id, key_version, evidence_domain_id::text, purpose, algorithm, key_base64url,
       ${iso("valid_from")} AS valid_from, ${iso("valid_to")} AS valid_to, ${iso("revoked_at")} AS revoked_at
  FROM evidence.signing_key
 WHERE evidence_domain_id = $1::uuid
 ORDER BY valid_from, key_id`;

const REFUSALS = new Set(["unauthenticated", "not_found", "not_accepting", "not_started"]);
const text = (value: unknown): value is string => typeof value === "string" && value !== "";
const unavailable = (reason: string): OpenWorkResult => ({ status: "unavailable", reason });

/** A count as the driver gives a bigint (text) or an integer; anything else is null. */
export function count(value: unknown): number | null {
  const n =
    typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

type Row = Record<string, unknown>;

/**
 * Every key of the domain whose purpose is receipt. A row of an unexpected
 * form makes the whole list unavailable; nothing is skipped. A checkpoint
 * key is checked like the others but never sent.
 */
export async function receiptKeys(
  tx: ActorTransaction,
  domainId: string,
): Promise<ReceiptKey[] | null> {
  const { rows } = await tx.query<Row>(KEYS_SQL, [domainId]);
  const keys: ReceiptKey[] = [];
  for (const row of rows) {
    const keyId = row.key_id;
    const keyVersion = row.key_version;
    const purpose = row.purpose;
    const keyBase64Url = row.key_base64url;
    const validFrom = row.valid_from;
    const validTo = row.valid_to;
    const revokedAt = row.revoked_at;
    if (
      !text(keyId) ||
      !text(keyVersion) ||
      row.evidence_domain_id !== domainId ||
      (purpose !== "receipt" && purpose !== "checkpoint") ||
      row.algorithm !== "Ed25519" ||
      !text(keyBase64Url) ||
      !text(validFrom) ||
      (validTo !== null && !text(validTo)) ||
      (revokedAt !== null && !text(revokedAt))
    ) {
      return null;
    }
    if (purpose !== "receipt") continue;
    keys.push({
      algorithm: "Ed25519",
      keyId,
      keyVersion,
      encoding: "spki-der",
      keyBase64Url,
      evidenceDomainId: domainId,
      purpose,
      validFrom,
      validTo,
      revokedAt,
    });
  }
  return keys;
}

async function open(tx: ActorTransaction, assignmentId: string, start: boolean) {
  const { rows } = await tx.query<Row>(OPEN_SQL, [assignmentId, start]);
  const row = rows.length === 1 ? rows[0] : undefined;
  const outcome = row?.outcome;
  if (typeof outcome === "string" && REFUSALS.has(outcome)) {
    return { status: outcome } as OpenWorkResult;
  }
  if (outcome === "not_configured") return unavailable("work_not_configured");
  const currentRevision = count(row?.current_revision);
  const lastSequenceTo = count(row?.last_sequence_to);
  if (
    row === undefined ||
    outcome !== "opened" ||
    !text(row.document_id) ||
    !text(row.evidence_profile_id) ||
    currentRevision === null ||
    lastSequenceTo === null ||
    !isSha256Hex(row.document_hash) ||
    !(row.head_segment_hash === null || isSha256Hex(row.head_segment_hash)) ||
    typeof row.snapshot !== "string"
  ) {
    return unavailable("work_malformed");
  }
  // Never false by assumption: an answer that is not a boolean is no answer.
  const submittedRows = await tx.query<Row>(SUBMITTED_SQL, [assignmentId]);
  const submitted = submittedRows.rows.length === 1 ? submittedRows.rows[0]?.submitted : undefined;
  if (typeof submitted !== "boolean") return unavailable("work_malformed");
  const domain = await tx.query<Row>(DOMAIN_SQL, [row.document_id]);
  const domainId = domain.rows[0]?.evidence_domain_id;
  // The id comes from the server's own package row; another form is a fault.
  if (!isEvidenceDomainId(domainId)) return unavailable("work_malformed");
  const keys = await receiptKeys(tx, domainId);
  if (keys === null) return unavailable("domain_keys_malformed");
  return {
    status: "opened",
    work: {
      documentId: row.document_id,
      evidenceProfileId: row.evidence_profile_id,
      currentRevision,
      documentHash: row.document_hash,
      headSegmentHash: row.head_segment_hash,
      lastSequenceTo,
      snapshot: row.snapshot,
      receiptKeys: keys,
      submitted,
    },
  } satisfies OpenWorkResult;
}

/** An opener over `withActor`; the token is only presented, never a parameter. */
export function createWorkOpener(withActor: WithActor): WorkOpener {
  return {
    openWork: (token, assignmentId, start) =>
      withActor(token, (tx) => open(tx, assignmentId, start)),
  };
}
