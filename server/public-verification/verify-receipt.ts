// SRV-9B (Ductus#2028 c.7041664094; ✓ C-6): the public check of a submission
// receipt. One read of app.public_receipt_verification without a session (the
// token is null, so the database sees no actor and the route never reads the
// cookie: D-09), then the Ed25519 check of the stored receipt with the key the
// read returned. The answer is match with the two instants and the key id, or
// match false; nothing else of the receipt leaves this file.
import type { WithActor } from "../database/index.ts";
import {
  isSubmissionReceiptPayloadV2,
  verifySignedSubmissionReceiptV2,
  type SubmissionReceiptPayloadV2,
} from "../domain/index.ts";

export type PublicVerificationAnswer =
  | {
      readonly match: true;
      readonly submittedAt: string;
      readonly signedAt: string;
      readonly keyId: string;
    }
  | { readonly match: false };

export type PublicVerificationResult =
  | { readonly status: "ok"; readonly answer: PublicVerificationAnswer }
  | { readonly status: "unavailable" };

/** Checks one pair of the receipt's QR: submission id and SHA-256 of the text. */
export type PublicVerification = (
  submissionId: string,
  artifactSha256: string,
) => Promise<PublicVerificationResult>;

const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

// ISO 8601 in UTC with milliseconds, by the database clock's own value, as
// server/database/receipt-keys.ts reads the same key columns.
const iso = (column: string, name: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${name}"`;
const SQL = `SELECT outcome, receipt_payload AS "payload", payload_digest_sha256 AS "digest",
       signature, key_base64url AS "keyBase64Url", key_evidence_domain_id::text AS "domain",
       key_purpose AS "purpose", ${iso("key_valid_from", "validFrom")},
       ${iso("key_valid_to", "validTo")}, ${iso("key_revoked_at", "revokedAt")}
  FROM app.public_receipt_verification($1::uuid, $2)`;

type Row = {
  outcome: unknown;
  payload: unknown;
  digest: unknown;
  signature: unknown;
  keyBase64Url: unknown;
  domain: unknown;
  purpose: unknown;
  validFrom: unknown;
  validTo: unknown;
  revokedAt: unknown;
};

const NO_MATCH: PublicVerificationResult = { status: "ok", answer: { match: false } };
const UNAVAILABLE: PublicVerificationResult = { status: "unavailable" };

function parsePayload(text: unknown): SubmissionReceiptPayloadV2 | null {
  if (typeof text !== "string") return null;
  try {
    const value: unknown = JSON.parse(text);
    return isSubmissionReceiptPayloadV2(value) ? value : null;
  } catch {
    return null;
  }
}

/** The verifier's answer for a match row; anything it refuses is match false. */
async function check(
  row: Row,
  submissionId: string,
  artifactSha256: string,
): Promise<PublicVerificationResult> {
  const payload = parsePayload(row.payload);
  const signature = row.signature;
  if (payload === null || typeof signature !== "object" || signature === null) return NO_MATCH;
  const { keyId, keyVersion } = signature as { keyId?: unknown; keyVersion?: unknown };
  if (typeof keyId !== "string" || typeof keyVersion !== "string") return NO_MATCH;
  const key = {
    algorithm: "Ed25519",
    keyId,
    keyVersion,
    encoding: "spki-der",
    keyBase64Url: row.keyBase64Url,
    evidenceDomainId: row.domain,
    purpose: row.purpose,
    validFrom: row.validFrom,
    validTo: row.validTo,
    revokedAt: row.revokedAt,
  };
  // The QR's own values stand in for the receipt's: another text never passes.
  const { receiptSchema: unusedSchema, signedAt: unusedSignedAt, ...rest } = payload;
  void unusedSchema;
  void unusedSignedAt;
  const expected = { ...rest, submissionId, artifactSha256 };
  const receipt = { payload, payloadDigestSha256: row.digest, signature };
  const verdict = await verifySignedSubmissionReceiptV2(receipt, expected, [key]);
  if (verdict.ok === false) {
    return verdict.reason === "verification_unavailable" ? UNAVAILABLE : NO_MATCH;
  }
  return {
    status: "ok",
    answer: {
      match: true,
      submittedAt: verdict.payload.requestedAt,
      signedAt: verdict.payload.signedAt,
      keyId,
    },
  };
}

export function createPublicVerification(withActor: WithActor): PublicVerification {
  return async (submissionId, artifactSha256) => {
    if (!SUBMISSION_ID.test(submissionId) || !SHA256.test(artifactSha256)) return NO_MATCH;
    let rows: Row[];
    try {
      // No token: the read runs as nobody, whatever cookie the request had.
      rows = await withActor(null, async (tx) => {
        const result = await tx.query<Row>(SQL, [submissionId, artifactSha256]);
        return result.rows;
      });
    } catch {
      return UNAVAILABLE;
    }
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return UNAVAILABLE;
    if (row.outcome === "no_match") return NO_MATCH;
    if (row.outcome !== "match") return UNAVAILABLE;
    return check(row, submissionId, artifactSha256);
  };
}
