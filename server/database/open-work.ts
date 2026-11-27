// The student's work for one assignment (DAN-811, VS-1 narrow cut, step 2).
// Port of Ductus src/server/evidence/open-route.ts (open) and
// evidence-domain-keys.ts at 078c780, without a change of logic: every
// statement runs in one withActor transaction and every row is checked
// before it leaves this folder; the rows become camelCase only here. The
// answer is a Result with an AppError (docs/CODE_STYLE.md §8; DAN-859,
// contract Ductus#1836 c.6946658606; text in locales/hr.json under
// `openWork`). An operational failure of withActor (a connection, an
// SQLSTATE, anything else that is no programming error) is
// OPEN_WORK_DATABASE_ERROR; a TypeError, RangeError, ReferenceError or
// SyntaxError stays an exception, so a bug never reads as a database outage
// (review FAIL c.6947022168 on ductura/server#242).
import { type AppError, isEvidenceDomainId, isSha256Hex, type Result } from "../domain/index.ts";

import {
  type DocumentSchemaVersion,
  readWorkVersion,
  type RevisionZeroKind,
} from "./evidence-work-version.ts";
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
  /** SRV-7F: the version of revision 0, and so of the work (contract v3 §7). */
  schemaVersion: DocumentSchemaVersion;
  /** SRV-7F: SHA-256 of revision 0 as the database recorded it, at every revision. */
  revisionZeroHash: string;
  /** The snapshot of currentRevision as the database holds it (JCS text). */
  snapshot: string;
  receiptKeys: ReceiptKey[];
  submitted: boolean;
  /**
   * IZV-RUTE-1a: `acceptedAt` of the newest signed receipt of the work's package (the signed
   * minute, as the receipt carries it), or null while no receipt of the work is signed.
   */
  lastSignedAt: string | null;
  /**
   * SRV-V14-KIND-ENUM: the kind of the work when it is not text; absent is "text".
   * F4-V14-R01: app.open_student_work opens text and spreadsheet works.
   */
  workKind?: "text" | "slides" | "spreadsheet";
};

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** No session behind the token. */
export const OPEN_WORK_UNAUTHENTICATED = error(
  "OPEN_WORK_UNAUTHENTICATED",
  "openWork.unauthenticated",
);
/** No such assignment for the caller. */
export const OPEN_WORK_NOT_FOUND = error("OPEN_WORK_NOT_FOUND", "openWork.not_found");
/** The assignment takes no work now. */
export const OPEN_WORK_NOT_ACCEPTING = error("OPEN_WORK_NOT_ACCEPTING", "openWork.not_accepting");
/** No work yet, and the caller did not ask to start one. */
export const OPEN_WORK_NOT_STARTED = error("OPEN_WORK_NOT_STARTED", "openWork.not_started");
/** C8: the assignment has no evidence configuration. */
export const OPEN_WORK_NOT_CONFIGURED = error(
  "OPEN_WORK_NOT_CONFIGURED",
  "openWork.not_configured",
);
/** A row of the work, its domain or its keys that is not what the statements return. */
export const OPEN_WORK_ROW_MALFORMED = error("OPEN_WORK_ROW_MALFORMED", "openWork.row_malformed");
/** The database could not be reached or answered with an error; its text never leaves. */
export const OPEN_WORK_DATABASE_ERROR = error(
  "OPEN_WORK_DATABASE_ERROR",
  "openWork.database_error",
);
export const OPEN_WORK_ERRORS: readonly AppError[] = [
  OPEN_WORK_UNAUTHENTICATED,
  OPEN_WORK_NOT_FOUND,
  OPEN_WORK_NOT_ACCEPTING,
  OPEN_WORK_NOT_STARTED,
  OPEN_WORK_NOT_CONFIGURED,
  OPEN_WORK_ROW_MALFORMED,
  OPEN_WORK_DATABASE_ERROR,
];

export type OpenWorkResult = Result<OpenedWork>;

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
// IZV-RUTE-1a: with it, the signed minute of that package's newest signed receipt (by the
// sequence its segment ends at); a receipt still pending signature is not counted.
const DOMAIN_SQL = `SELECT p.evidence_domain_id::text AS evidence_domain_id,
       (SELECT r.receipt_payload::jsonb->>'acceptedAt'
          FROM evidence.receipt r
          JOIN evidence.segment s
            ON s.id = r.segment_id AND s.evidence_package_id = r.evidence_package_id
           AND s.institution_id = r.institution_id
         WHERE r.evidence_package_id = p.id AND r.institution_id = p.institution_id
           AND r.status = 'signed'
         ORDER BY s.sequence_to DESC LIMIT 1) AS last_signed_at
  FROM evidence.package p
 WHERE p.document_id = $1 ORDER BY p.created_at, p.id LIMIT 1`;
/** The receipt's own form of `acceptedAt`: UTC, to the minute. */
const SIGNED_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
// ISO 8601 in UTC with milliseconds, formatted by the database, never by a driver's time zone.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO})`;
// Under RLS the session sees only its own documents; the kind is written once, when the work
// starts, and never updated.
const KIND_SQL = "SELECT document_kind FROM evidence.document WHERE id = $1";
// A Map, not an object: a value such as `__proto__` is no kind. Slides have no revision 0 yet.
const KINDS = new Map<unknown, RevisionZeroKind>([
  ["text", "text"],
  ["spreadsheet", "spreadsheet"],
]);
const KEYS_SQL = `
SELECT key_id, key_version, evidence_domain_id::text, purpose, algorithm, key_base64url,
       ${iso("valid_from")} AS valid_from, ${iso("valid_to")} AS valid_to, ${iso("revoked_at")} AS revoked_at
  FROM evidence.signing_key
 WHERE evidence_domain_id = $1::uuid
 ORDER BY valid_from, key_id`;

// A Map, not an object: an outcome such as `toString` or `__proto__` is no refusal.
const REFUSALS = new Map<unknown, AppError>([
  ["unauthenticated", OPEN_WORK_UNAUTHENTICATED],
  ["not_found", OPEN_WORK_NOT_FOUND],
  ["not_accepting", OPEN_WORK_NOT_ACCEPTING],
  ["not_started", OPEN_WORK_NOT_STARTED],
  ["not_configured", OPEN_WORK_NOT_CONFIGURED],
]);
const text = (value: unknown): value is string => typeof value === "string" && value !== "";
const fail = (e: AppError): OpenWorkResult => ({ ok: false, error: e });
const malformed = (): OpenWorkResult => fail(OPEN_WORK_ROW_MALFORMED);

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

async function open(
  tx: ActorTransaction,
  assignmentId: string,
  start: boolean,
): Promise<OpenWorkResult> {
  const { rows } = await tx.query<Row>(OPEN_SQL, [assignmentId, start]);
  const row = rows.length === 1 ? rows[0] : undefined;
  const outcome = row?.outcome;
  const refusal = REFUSALS.get(outcome);
  if (refusal !== undefined) return fail(refusal);
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
    return malformed();
  }
  // Never false by assumption: an answer that is not a boolean is no answer.
  const submittedRows = await tx.query<Row>(SUBMITTED_SQL, [assignmentId]);
  const submitted = submittedRows.rows.length === 1 ? submittedRows.rows[0]?.submitted : undefined;
  if (typeof submitted !== "boolean") return malformed();
  // SRV-7F: the version is the server's record of revision 0; at revision 0
  // the snapshot the work opens with is that revision, so the hashes agree.
  // The kind of the work is the server's record, written when the work started (F4-V14-R01).
  const kindRows = await tx.query<Row>(KIND_SQL, [row.document_id]);
  const kind = kindRows.rows.length === 1 ? KINDS.get(kindRows.rows[0]?.document_kind) : undefined;
  if (kind === undefined) return malformed();
  const version = await readWorkVersion(tx, row.document_id, kind);
  if (version === null) return malformed();
  if (currentRevision === 0 && row.document_hash !== version.revisionZeroHash) return malformed();
  const domain = await tx.query<Row>(DOMAIN_SQL, [row.document_id]);
  const domainId = domain.rows[0]?.evidence_domain_id;
  // The id comes from the server's own package row; another form is a fault.
  if (!isEvidenceDomainId(domainId)) return malformed();
  const lastSignedAt = domain.rows[0]?.last_signed_at;
  if (!(
    lastSignedAt === null ||
    (typeof lastSignedAt === "string" && SIGNED_MINUTE.test(lastSignedAt))
  )) {
    return malformed();
  }
  const keys = await receiptKeys(tx, domainId);
  if (keys === null) return malformed();
  return {
    ok: true,
    value: {
      documentId: row.document_id,
      evidenceProfileId: row.evidence_profile_id,
      currentRevision,
      documentHash: row.document_hash,
      headSegmentHash: row.head_segment_hash,
      lastSequenceTo,
      schemaVersion: version.schemaVersion,
      revisionZeroHash: version.revisionZeroHash,
      snapshot: row.snapshot,
      receiptKeys: keys,
      submitted,
      lastSignedAt,
      ...(kind === "spreadsheet" ? { workKind: kind } : {}),
    },
  };
}

/** An opener over `withActor`; the token is only presented, never a parameter. */
/** Whether a thrown value is a programming error; one that cannot be read is treated as one. */
function isProgrammingError(thrown: unknown): boolean {
  try {
    return (
      thrown instanceof TypeError ||
      thrown instanceof RangeError ||
      thrown instanceof ReferenceError ||
      thrown instanceof SyntaxError
    );
  } catch {
    return true;
  }
}

export function createWorkOpener(withActor: WithActor): WorkOpener {
  return {
    async openWork(token, assignmentId, start) {
      try {
        return await withActor(token, (tx) => open(tx, assignmentId, start));
      } catch (thrown) {
        if (isProgrammingError(thrown)) throw thrown;
        return fail(OPEN_WORK_DATABASE_ERROR);
      }
    },
  };
}
