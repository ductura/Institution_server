// The answer of the segment object check, read before anything is signed
// (DAN-820, VS-1b part 1, 820c-4a; plan of attack ductura/server#146 P-6).
// Port of `PendingReceiptObjectCheck` from Ductus
// src/application/evidence/check-pending-receipt-object.ts and of `HOLDS`,
// `UNAVAILABLE` and the block of `signPendingReceipt` that reads the check's
// answer, from sign-pending-receipt.ts, at 333e163. The block is a function
// of its own here, word for word; the factory (820c-4b) calls it. The check
// itself (DAN-301) is a port the caller passes in.
import { isPlainObject } from "../domain/index.ts";

import type { PendingReceiptHold, SignPendingReceiptOutcome } from "./settle-attach.ts";

export type PendingReceiptObjectCheck =
  | { status: "present" }
  | { status: "held"; reason: PendingReceiptHold }
  | {
      status: "unavailable";
      reason:
        | "locator_unavailable"
        | "locator_malformed"
        | "storage_ref_unavailable"
        | "presence_unavailable";
    };

const HOLDS: ReadonlySet<unknown> = new Set<PendingReceiptHold>([
  "not_pending",
  "locator_mismatch",
  "object_absent",
  "object_mismatch",
]);
const UNAVAILABLE: ReadonlySet<unknown> = new Set([
  "locator_unavailable",
  "locator_malformed",
  "storage_ref_unavailable",
  "presence_unavailable",
]);

/**
 * Null when the object the receipt names is there; otherwise the outcome
 * that stops the call before the signer. The check is an outside port: an
 * answer outside its type is `presence_unavailable`, never `present`.
 */
export function objectOutcome(object: unknown): SignPendingReceiptOutcome | null {
  if (!isPlainObject(object) || object.status !== "present") {
    if (isPlainObject(object) && object.status === "held" && HOLDS.has(object.reason)) {
      return { status: "held", reason: object.reason as PendingReceiptHold };
    }
    const reason =
      isPlainObject(object) && object.status === "unavailable" && UNAVAILABLE.has(object.reason)
        ? (object.reason as string)
        : "presence_unavailable";
    return { status: "unavailable", stage: "object", reason };
  }
  return null;
}
