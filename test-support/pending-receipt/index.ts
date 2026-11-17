// Shared fixtures of the pending receipt signing tests (DAN-820, 820c),
// ported from Ductus src/application/evidence/sign-pending-receipt.test.ts at
// 333e163; 820c-3 adds testKey. Every value here is invented for the test.
import { generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  type EvidenceDomainKey,
  type EvidenceReceiptPayloadV2,
  type SignatureEnvelope,
  type SignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";

export const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
export const OTHER_DOMAIN = "00000000-0000-4000-8000-0000000000d2";
export const RECEIPT = "00000000-0000-4000-8000-0000000000c1";
export const PAYLOAD: EvidenceReceiptPayloadV2 = {
  receiptSchema: "ductus-evidence-receipt-v2",
  receiptId: RECEIPT,
  evidenceDomainId: DOMAIN,
  evidencePackageId: "pkg-1",
  documentId: "doc-1",
  revision: 1,
  clientTransactionId: "tx-1",
  principalId: "00000000-0000-4000-8000-0000000000e1",
  sessionId: "session-1",
  segmentId: "segment-1",
  segmentHash: "b".repeat(64),
  predecessorSegmentHash: null,
  previousReceiptId: null,
  evidenceSchema: "ductus-evidence-segment-v2",
  evidenceProfileId: "standard-v1",
  sequenceFrom: 1,
  sequenceTo: 1,
  eventCount: 1,
  payloadBytes: 123,
  acceptedAt: "2026-10-19T06:00:00.000Z",
};
export const TEXT = canonicalizeJcs(PAYLOAD);
export const ROW = { receiptId: RECEIPT, receiptPayloadText: TEXT };

/**
 * An ephemeral Ed25519 receipt key (`testSigner` of the source without the
 * provider): its envelope over any input, its registry row with `scope`, and
 * the receipt of PAYLOAD it signs.
 */
export function testKey(keyId: string) {
  const pair = generateKeyPairSync("ed25519");
  const envelope = (input: Uint8Array): SignatureEnvelope => ({
    algorithm: "Ed25519",
    keyId,
    keyVersion: "1",
    signatureEncoding: "raw",
    signatureBase64Url: sign(null, input, pair.privateKey).toString("base64url"),
  });
  const key = (scope: Partial<EvidenceDomainKey> = {}): EvidenceDomainKey => ({
    algorithm: "Ed25519",
    keyId,
    keyVersion: "1",
    encoding: "spki-der",
    keyBase64Url: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    evidenceDomainId: DOMAIN,
    purpose: "receipt",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    revokedAt: null,
    ...scope,
  });
  const signedReceipt = async (): Promise<SignedEvidenceReceiptV2> => {
    const digest = await digestEvidenceReceiptPayloadV2(PAYLOAD);
    return {
      payload: PAYLOAD,
      payloadDigestSha256: digest.sha256,
      signature: envelope(digest.signingInput),
    };
  };
  return { envelope, key, signedReceipt };
}
