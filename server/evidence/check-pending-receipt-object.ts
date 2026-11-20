// Port of Ductus src/application/evidence/check-pending-receipt-object.ts at
// 0cdb0f1 (DAN-301), copied for its test (ZEL-S2). The logic is word for word.
// The answer and hold types are the ones Ductura already ports in
// object-check.ts and settle-attach.ts, so there is one definition of each;
// isInstitutionId comes from domain/evidence/object-key.ts, the Ductura port of
// Ductus src/application/ports/evidence-object-key.ts.
import { isEvidencePackageId, isSha256Hex } from "../application/ports/evidence-ingest.ts";
import type { EvidencePayloadLocator } from "../application/ports/evidence-trust.ts";
import type {
  EvidencePayloadPresence,
  PendingReceiptObject,
  PendingReceiptObjectSource,
} from "../application/ports/pending-receipt-object.ts";
import { MAX_EVIDENCE_SEGMENT_BYTES } from "../domain/forensics/evidence-chain-v2.ts";
import type { EvidenceReceiptPayloadV2 } from "../domain/forensics/evidence-receipt.ts";
import { isInstitutionId } from "../domain/evidence/object-key.ts";
import { isPlainObject } from "../domain/json/index.ts";

import type { PendingReceiptObjectCheck } from "./object-check.ts";

export type { PendingReceiptObjectCheck } from "./object-check.ts";
export type { PendingReceiptHold } from "./settle-attach.ts";

export type CheckPendingReceiptObjectDeps = {
  source: PendingReceiptObjectSource;
  locator: EvidencePayloadLocator;
  presence: EvidencePayloadPresence;
};

/** A copy of the row with exactly the fields and forms the database allows. */
function readRow(value: unknown): PendingReceiptObject | null {
  if (!isPlainObject(value)) return null;
  const { institutionId, evidencePackageId, segmentHash, payloadBytes, storageRef } = value;
  if (
    !isInstitutionId(institutionId) ||
    !isEvidencePackageId(evidencePackageId) ||
    !isSha256Hex(segmentHash) ||
    !Number.isSafeInteger(payloadBytes) ||
    (payloadBytes as number) < 1 ||
    (payloadBytes as number) > MAX_EVIDENCE_SEGMENT_BYTES ||
    typeof storageRef !== "string"
  ) {
    return null;
  }
  return {
    institutionId,
    evidencePackageId,
    segmentHash,
    payloadBytes: payloadBytes as number,
    storageRef,
  };
}

/**
 * Checks, before a pending receipt v2 is signed, that the segment object it
 * names is in the payload store (DAN-301, plan #1690). The key comes from
 * the locator row, never from the payload alone: the institution is the one
 * the database keeps for the package. The row must agree with the payload on
 * package, hash and byte count, and its stored reference with the one the
 * locator computes for that key; then one HEAD decides. Only `present` lets
 * the caller sign. Every port is outside: a reply of another shape or a
 * thrown error is `unavailable`, never `present`.
 */
export function createCheckPendingReceiptObject(deps: CheckPendingReceiptObjectDeps) {
  const { source, locator, presence } = deps;

  return async function checkPendingReceiptObject(
    payload: EvidenceReceiptPayloadV2,
  ): Promise<PendingReceiptObjectCheck> {
    let row: PendingReceiptObject | null;
    try {
      const read: unknown = await source.receiptObject(payload.evidenceDomainId, payload.receiptId);
      if (!isPlainObject(read)) {
        return { status: "unavailable", reason: "locator_unavailable" };
      }
      if (read.status === "not_found") return { status: "held", reason: "not_pending" };
      if (read.status !== "ok") {
        return { status: "unavailable", reason: "locator_unavailable" };
      }
      row = readRow(read.object);
    } catch {
      return { status: "unavailable", reason: "locator_unavailable" };
    }
    if (row === null) return { status: "unavailable", reason: "locator_malformed" };
    if (
      row.evidencePackageId !== payload.evidencePackageId ||
      row.segmentHash !== payload.segmentHash ||
      row.payloadBytes !== payload.payloadBytes
    ) {
      return { status: "held", reason: "locator_mismatch" };
    }

    const key = {
      institutionId: row.institutionId,
      evidencePackageId: row.evidencePackageId,
      segmentHash: row.segmentHash,
    };
    try {
      const ref: unknown = await locator.storageRefFor(key);
      if (!isPlainObject(ref) || ref.status !== "ok" || typeof ref.storageRef !== "string") {
        return { status: "unavailable", reason: "storage_ref_unavailable" };
      }
      if (ref.storageRef !== row.storageRef) {
        return { status: "held", reason: "locator_mismatch" };
      }
    } catch {
      return { status: "unavailable", reason: "storage_ref_unavailable" };
    }

    let head: unknown;
    try {
      head = await presence.headImmutable({ ...key, payloadBytes: row.payloadBytes });
    } catch {
      return { status: "unavailable", reason: "presence_unavailable" };
    }
    const status = isPlainObject(head) ? head.status : undefined;
    switch (status) {
      case "present":
        return { status: "present" };
      case "absent":
        return { status: "held", reason: "object_absent" };
      case "mismatch":
        return { status: "held", reason: "object_mismatch" };
      default:
        return { status: "unavailable", reason: "presence_unavailable" };
    }
  };
}
