import { isSignatureEnvelope, type SignatureEnvelope } from "./signature.ts";
import { sha256WebCrypto } from "./crypto.ts";
import { canonicalizeJcs } from "./jcs.ts";
import {
  isSubmissionReceiptPayloadV2,
  SUBMISSION_RECEIPT_SCHEMA_V2,
  type SubmissionReceiptPayloadV2,
} from "./submission-receipt-v2.ts";
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";

// declaration-v1 section 6.4, option A (OD-2, SRV-1214): the sixteen fields
// of v2 with their own schema value and a mandatory declarationSha256, so one
// signature covers the submission and the declaration pinned on its request.
// v2 is unchanged and stays byte-equal; its receipts are never rewritten.
// The issuer, the submission routes and /provjera still issue and read v2:
// moving them to v3 is a new major of the route contract (section 6.4).
export const SUBMISSION_RECEIPT_SCHEMA_V3 = "ductus-submission-receipt-v3" as const;
export const SUBMISSION_RECEIPT_V3_SIGNING_INPUT_BYTES = 61;
const PREFIX = new TextEncoder().encode(SUBMISSION_RECEIPT_SCHEMA_V3 + "\n");
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SubmissionReceiptPayloadV3 = Omit<SubmissionReceiptPayloadV2, "receiptSchema"> & {
  receiptSchema: typeof SUBMISSION_RECEIPT_SCHEMA_V3;
  /** The hash of the pinned declaration version, or null when none was pinned (6.3). */
  declarationSha256: string | null;
};

export type SignedSubmissionReceiptV3 = {
  payload: SubmissionReceiptPayloadV3;
  payloadDigestSha256: string;
  signature: SignatureEnvelope;
};

const PAYLOAD_KEYS = new Set<keyof SubmissionReceiptPayloadV3>([
  "receiptSchema",
  "submissionId",
  "evidenceDomainId",
  "principalId",
  "assignmentId",
  "assignmentVersion",
  "documentId",
  "evidencePackageId",
  "revision",
  "artifactSha256",
  "evidenceHeadSegmentHash",
  "evidenceRecord",
  "requestedAt",
  "dueAt",
  "afterDeadline",
  "signedAt",
  "declarationSha256",
]);
const SIGNED_KEYS = new Set(["payload", "payloadDigestSha256", "signature"]);

/** Exactly the enumerable data fields that will enter JCS; never invoke a getter. */
function dataObject(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, keys) &&
    Reflect.ownKeys(value).length === keys.size &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d && d.enumerable,
    )
  );
}

export function isSubmissionReceiptPayloadV3(value: unknown): value is SubmissionReceiptPayloadV3 {
  if (!dataObject(value, PAYLOAD_KEYS) || value.receiptSchema !== SUBMISSION_RECEIPT_SCHEMA_V3)
    return false;
  const { declarationSha256, ...base } = value;
  // The sixteen shared fields keep exactly the v2 rules; a v2 receipt itself
  // has no declarationSha256 and is never accepted as v3.
  return (
    (declarationSha256 === null ||
      (typeof declarationSha256 === "string" && SHA256_HEX.test(declarationSha256))) &&
    isSubmissionReceiptPayloadV2({ ...base, receiptSchema: SUBMISSION_RECEIPT_SCHEMA_V2 })
  );
}

/** Format/digest only. Issuers must obtain signedAt and declarationSha256 from the DB. */
export async function digestSubmissionReceiptPayloadV3(
  payload: SubmissionReceiptPayloadV3,
): Promise<{
  canonical: string;
  sha256: string;
  signingInput: Uint8Array<ArrayBuffer>;
}> {
  if (!isSubmissionReceiptPayloadV3(payload))
    throw new Error("submission receipt v3: not a v3 payload");
  const canonical = canonicalizeJcs(payload);
  const sha256 = await sha256WebCrypto(canonical);
  if (!SHA256_HEX.test(sha256)) throw new Error("submission receipt v3: SHA-256 unavailable");
  const signingInput = new Uint8Array(SUBMISSION_RECEIPT_V3_SIGNING_INPUT_BYTES);
  signingInput.set(PREFIX);
  for (let i = 0; i < 32; i++)
    signingInput[PREFIX.byteLength + i] = Number.parseInt(sha256.slice(2 * i, 2 * i + 2), 16);
  return { canonical, sha256, signingInput };
}

/** Shape only. This checks neither a signature nor a trusted key/expected tuple. */
export function isSignedSubmissionReceiptV3(value: unknown): value is SignedSubmissionReceiptV3 {
  return (
    dataObject(value, SIGNED_KEYS) &&
    isSubmissionReceiptPayloadV3(value.payload) &&
    typeof value.payloadDigestSha256 === "string" &&
    SHA256_HEX.test(value.payloadDigestSha256) &&
    isSignatureEnvelope(value.signature) &&
    value.signature.algorithm === "Ed25519"
  );
}
