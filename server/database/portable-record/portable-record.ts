// The source of the portable record of one submission (SRV-1312, plan M7.10),
// for the student who submitted it and nobody else. Three existing reads in
// one withActor transaction, so the session decides every one of them:
// app.read_submission_receipt answers only the caller's own receipt (anyone
// else, an unknown id and a submission without a receipt read alike as
// not_found, C-23); app.read_work_export gives the exact stored text of the
// submitted revision, for the owner of the work; and
// app.public_receipt_verification, the read of the public check (SRV-9B),
// names the key the receipt is signed with. Nothing here writes. Every row is
// checked before it leaves this folder; the receipt itself is verified by the
// builder (server/downloads/portable-record).
import { canonicalInstant, isSubmissionReceiptPayloadV2 } from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

export type PortableRecordRows = {
  /** The stored receipt payload text (its own JCS). */
  readonly receiptPayload: string;
  readonly payloadDigestSha256: string;
  readonly signature: unknown;
  /** The receipt key with its validity, in the form the receipt verifier takes. */
  readonly key: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly keyVersion: string;
    readonly encoding: "spki-der";
    readonly keyBase64Url: string;
    readonly evidenceDomainId: string;
    readonly purpose: string;
    readonly validFrom: string;
    readonly validTo: string | null;
    readonly revokedAt: string | null;
  };
  /** The exact stored text of the submitted revision. */
  readonly text: string;
};

export type PortableRecordRead =
  | { readonly status: "found"; readonly rows: PortableRecordRows }
  | { readonly status: "not_found" }
  | { readonly status: "unauthenticated" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | {
      readonly status: "unavailable";
      readonly reason: "receipt_malformed" | "text_malformed" | "key_malformed";
    };

/** The source of `submissionId` for the session `token`. */
export type PortableRecordReader = (
  token: string,
  submissionId: string,
) => Promise<PortableRecordRead>;

type Row = Record<string, unknown>;

const RECEIPT_SQL = `SELECT outcome, receipt_payload AS "payload", payload_digest_sha256 AS "digest", signature
  FROM app.read_submission_receipt($1::uuid)`;
const TEXT_SQL = `SELECT outcome, revision::text AS revision, body
  FROM app.read_work_export($1, $2::bigint)`;
// ISO 8601 in UTC with milliseconds, by the database clock's own value, as
// server/public-verification reads the same key columns.
const iso = (column: string, name: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${name}"`;
const KEY_SQL = `SELECT outcome, key_base64url AS "keyBase64Url", key_evidence_domain_id::text AS "domain",
       key_purpose AS "purpose", ${iso("key_valid_from", "validFrom")},
       ${iso("key_valid_to", "validTo")}, ${iso("key_revoked_at", "revokedAt")}
  FROM app.public_receipt_verification($1::uuid, $2)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NOT_FOUND = { status: "not_found" } as const;
const unavailable = (reason: "receipt_malformed" | "text_malformed" | "key_malformed") =>
  ({ status: "unavailable", reason }) as const;

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

const instantOrNull = (value: unknown): value is string | null =>
  value === null || canonicalInstant(value);

type Signature = { keyId: string; keyVersion: string };

function signatureOf(value: unknown): Signature | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { keyId, keyVersion } = value as Record<string, unknown>;
  return typeof keyId === "string" && typeof keyVersion === "string" ? { keyId, keyVersion } : null;
}

/** The key row as the verifier's key, or null when any column is not of its form. */
export function keyOf(
  row: Row | undefined,
  signature: Signature,
): PortableRecordRows["key"] | null {
  if (row?.outcome !== "match") return null;
  const { keyBase64Url, domain, purpose, validFrom, validTo, revokedAt } = row;
  if (
    typeof keyBase64Url !== "string" ||
    !BASE64URL.test(keyBase64Url) ||
    typeof domain !== "string" ||
    !UUID.test(domain) ||
    typeof purpose !== "string" ||
    !canonicalInstant(validFrom) ||
    !instantOrNull(validTo) ||
    !instantOrNull(revokedAt)
  ) {
    return null;
  }
  return {
    algorithm: "Ed25519",
    keyId: signature.keyId,
    keyVersion: signature.keyVersion,
    encoding: "spki-der",
    keyBase64Url,
    evidenceDomainId: domain,
    purpose,
    validFrom,
    validTo,
    revokedAt,
  };
}

type Answer = PortableRecordRead;

/** The reader over main's application withActor; the token is only presented, never a parameter. */
export function createPortableRecordReader(withActor: WithActor): PortableRecordReader {
  return async (token, submissionId) => {
    if (!UUID.test(submissionId)) return NOT_FOUND;
    try {
      return await withActor<Answer>(token, async (tx) => {
        const receipts = (await tx.query<Row>(RECEIPT_SQL, [submissionId])).rows;
        if (receipts.length !== 1) return unavailable("receipt_malformed");
        const receipt = receipts[0]!;
        if (receipt.outcome === "unauthorized") return { status: "unauthenticated" };
        if (receipt.outcome === "not_found" || receipt.outcome === "none") return NOT_FOUND;
        const { payload: text, digest, signature } = receipt;
        if (receipt.outcome !== "found" || typeof text !== "string" || typeof digest !== "string")
          return unavailable("receipt_malformed");
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return unavailable("receipt_malformed");
        }
        const signed = signatureOf(signature);
        if (
          !isSubmissionReceiptPayloadV2(payload) ||
          payload.submissionId !== submissionId ||
          !SHA256.test(digest) ||
          signed === null
        ) {
          return unavailable("receipt_malformed");
        }

        const texts = (await tx.query<Row>(TEXT_SQL, [payload.documentId, payload.revision])).rows;
        if (texts.length !== 1) return unavailable("text_malformed");
        // A practice assignment's work has no export: no portable record either.
        if (texts[0]!.outcome === "not_found") return NOT_FOUND;
        const { body, revision } = texts[0]!;
        if (
          texts[0]!.outcome !== "found" ||
          revision !== String(payload.revision) ||
          typeof body !== "string" ||
          body === ""
        ) {
          return unavailable("text_malformed");
        }

        const keys = (await tx.query<Row>(KEY_SQL, [submissionId, payload.artifactSha256])).rows;
        const key = keys.length === 1 ? keyOf(keys[0], signed) : null;
        if (key === null) return unavailable("key_malformed");
        return {
          status: "found",
          rows: { receiptPayload: text, payloadDigestSha256: digest, signature, key, text: body },
        };
      });
    } catch (error) {
      // ZD401: no open session (DAN-85). Anything else is the route's 503.
      if (codeOf(error) === "ZD401") return { status: "unauthenticated" };
      throw error;
    }
  };
}
