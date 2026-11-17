// Shared fixtures of the pending receipt signing tests (DAN-820, 820c),
// ported from Ductus src/application/evidence/sign-pending-receipt.test.ts at
// 333e163. Every value here is invented for the test.
import { canonicalizeJcs, type EvidenceReceiptPayloadV2 } from "../../server/domain/index.ts";

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
