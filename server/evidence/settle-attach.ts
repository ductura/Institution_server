// The store's answer to an attach, turned into the outcome of signing a
// pending receipt (DAN-820, VS-1b part 1, 820c-3; plan of attack
// ductura/server#146 P-4, P-5, P-7). Port of `settle` and of the outcome type
// from Ductus src/application/evidence/sign-pending-receipt.ts at 333e163,
// word for word; `settle` was a closure of the factory there and is a
// function of its own here, with the same calls to the protocol 1 verifier.
import type { AttachReceiptSignatureOutcome } from "../database/index.ts";
import {
  EVIDENCE_VERIFICATION_UNAVAILABLE,
  isPlainObject,
  verifySignedEvidenceReceiptV2,
  type EvidenceDomainKey,
  type SignedEvidenceReceiptV2,
} from "../domain/index.ts";

import type { PendingReceiptRefusal } from "./pending-receipt-text.ts";
import { sameSignature } from "./sign-within.ts";

/** Why a receipt is not signed now and stays `pending_signature` (P-13). */
export type PendingReceiptHold =
  "not_pending" | "locator_mismatch" | "object_absent" | "object_mismatch";

export type SignPendingReceiptOutcome =
  | { status: "signed"; signedReceipt: SignedEvidenceReceiptV2 }
  | { status: "already_signed"; signedReceipt: SignedEvidenceReceiptV2 }
  | { status: "refused"; reason: PendingReceiptRefusal }
  /**
   * The segment object is not confirmed in the payload store (DAN-301):
   * nothing is signed or stored and the receipt stays pending (P-13).
   */
  | { status: "held"; reason: PendingReceiptHold }
  /** The signature did not pass the domain's key registry; nothing stored. */
  | { status: "signer_rejected"; reason: string }
  /** Nothing is known of the receipt; the worker may try it again later. */
  | {
      status: "unavailable";
      stage: "hash" | "keys" | "object" | "signing" | "verification" | "store";
      reason: string;
    };

/** The receipt checked as protocol 1 checks it, against its own payload. */
export async function verifiedReceipt(
  receipt: SignedEvidenceReceiptV2,
  keys: readonly EvidenceDomainKey[],
) {
  const { payload } = receipt;
  return verifySignedEvidenceReceiptV2(
    receipt,
    {
      documentId: payload.documentId,
      clientTransactionId: payload.clientTransactionId,
      revision: payload.revision,
      evidenceDomainId: payload.evidenceDomainId,
    },
    keys,
  );
}

export async function settle(
  attached: AttachReceiptSignatureOutcome,
  own: SignedEvidenceReceiptV2,
  keys: readonly EvidenceDomainKey[],
): Promise<SignPendingReceiptOutcome> {
  // The store is an outside port: a reply that is not an object with a
  // string outcome is answered as unknown, never read further.
  if (!isPlainObject(attached) || typeof attached.outcome !== "string") {
    return { status: "unavailable", stage: "store", reason: "unknown_outcome" };
  }
  switch (attached.outcome) {
    case "signed":
      // `signed` must carry the signature this call sent; anything else is
      // not known to be what was stored.
      return sameSignature(attached.signature, own.signature)
        ? { status: "signed", signedReceipt: own }
        : { status: "unavailable", stage: "store", reason: "stored_signature_mismatch" };
    case "already_signed": {
      // The stored signature is answered only once it verifies as well.
      const stored = {
        payload: own.payload,
        payloadDigestSha256: own.payloadDigestSha256,
        signature: attached.signature,
      } as SignedEvidenceReceiptV2;
      const check = await verifiedReceipt(stored, keys);
      if (check.ok) return { status: "already_signed", signedReceipt: stored };
      return check.reason === EVIDENCE_VERIFICATION_UNAVAILABLE
        ? { status: "unavailable", stage: "verification", reason: check.reason }
        : { status: "unavailable", stage: "store", reason: "stored_signature_unverified" };
    }
    case "invalid":
    case "not_found":
    case "unsupported_schema":
    case "digest_mismatch":
      return { status: "refused", reason: attached.outcome };
    case "key_unknown":
    case "key_scope":
    case "key_revoked":
    case "key_not_valid":
      return { status: "signer_rejected", reason: attached.outcome };
    case "unavailable":
      return { status: "unavailable", stage: "store", reason: "store_unavailable" };
    default:
      return { status: "unavailable", stage: "store", reason: "unknown_outcome" };
  }
}
