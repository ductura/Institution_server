import { hasOnlyKeys, isPlainObject } from "../json/index.ts";
import {
  verifySignedSubmissionReceiptWith,
  type SubmissionReceiptFormat,
  type SubmissionReceiptVerification,
} from "./submission-receipt-verifier-v2.ts";
import {
  digestSubmissionReceiptPayloadV3,
  isSignedSubmissionReceiptV3,
  isSubmissionReceiptPayloadV3,
  SUBMISSION_RECEIPT_SCHEMA_V3,
  type SubmissionReceiptPayloadV3,
} from "./submission-receipt-v3.ts";

/**
 * Caller-owned authorized context, obtained separately from the receipt
 * response: the v2 tuple and the declaration hash pinned on the request
 * (declaration-v1 6.1), or null when the request pinned none (6.3).
 */
export type SubmissionReceiptExpectationV3 = Omit<
  SubmissionReceiptPayloadV3,
  "receiptSchema" | "signedAt"
>;
export type SubmissionReceiptVerificationV3 =
  SubmissionReceiptVerification<SubmissionReceiptPayloadV3>;

const EXPECTED = new Set<keyof SubmissionReceiptExpectationV3>([
  "submissionId",
  "principalId",
  "evidenceDomainId",
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
  "declarationSha256",
]);

function isExpected(value: unknown): value is SubmissionReceiptExpectationV3 {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, EXPECTED) &&
    Reflect.ownKeys(value).length === EXPECTED.size &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d && d.enumerable,
    ) &&
    isSubmissionReceiptPayloadV3({
      ...value,
      receiptSchema: SUBMISSION_RECEIPT_SCHEMA_V3,
      signedAt: value.requestedAt,
    })
  );
}

const V3_FORMAT: SubmissionReceiptFormat<SubmissionReceiptPayloadV3> = {
  isExpected,
  isSigned: isSignedSubmissionReceiptV3,
  digest: digestSubmissionReceiptPayloadV3,
};

/**
 * Pure, never-throw verifier of submission receipt v3 (declaration-v1 6.4,
 * option A). The same checks as v2 over the v3 signing input; the expected
 * declarationSha256 must match too, so a receipt cannot be shown with another
 * declaration or without the one its request pinned. No runtime caller yet:
 * the routes and /provjera still serve v2 (section 6.4).
 */
export async function verifySignedSubmissionReceiptV3(
  signedReceipt: unknown,
  expected: unknown,
  trustedKeys: readonly unknown[],
): Promise<SubmissionReceiptVerificationV3> {
  return verifySignedSubmissionReceiptWith(V3_FORMAT, signedReceipt, expected, trustedKeys);
}
