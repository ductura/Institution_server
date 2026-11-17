// Signs one pending receipt v2 for the worker (DAN-820, VS-1b part 1, 820c-4b;
// plan of attack ductura/server#146 P-1 … P-8). Port of
// `createSignPendingReceipt` and `SignPendingReceiptDeps` from Ductus
// src/application/evidence/sign-pending-receipt.ts at 333e163. The text, the
// signer, the store's answer and the object check's answer are read by
// 820c-1 … 820c-4a; this is the factory that runs them in the source's order.
// The object check itself (DAN-301) is a port the caller passes in.
import type {
  AttachReceiptSignatureOutcome,
  PendingReceiptRow,
  PendingReceiptStore,
  ReceiptSigner,
} from "../database/index.ts";
import {
  digestEvidenceReceiptPayloadV2,
  EVIDENCE_RECEIPT_V2_SIGNING_INPUT_BYTES,
  EVIDENCE_VERIFICATION_UNAVAILABLE,
  EvidenceHashUnavailableError,
  type EvidenceDomainKey,
  type EvidenceReceiptPayloadV2,
  type SignedEvidenceReceiptV2,
} from "../domain/index.ts";

import { objectOutcome, type PendingReceiptObjectCheck } from "./object-check.ts";
import { parsePendingReceipt } from "./pending-receipt-text.ts";
import { settle, verifiedReceipt, type SignPendingReceiptOutcome } from "./settle-attach.ts";
import { MAX_SIGN_TIMEOUT_MS, signWithin } from "./sign-within.ts";

export type SignPendingReceiptDeps = {
  signer: ReceiptSigner;
  store: PendingReceiptStore;
  /**
   * `createCheckPendingReceiptObject` (DAN-301). Required: no receipt is
   * signed before its segment object is confirmed in the store.
   */
  checkObject: (payload: EvidenceReceiptPayloadV2) => Promise<PendingReceiptObjectCheck>;
  signTimeoutMs: number;
};

/**
 * Signs one pending receipt v2 through the signing port (D-92) and stores
 * the signature through the worker's store, only once the segment object it
 * names is confirmed in the payload store (DAN-301). The signature is stored only
 * after it passes the verifier with a receipt key of the payload's own
 * domain from the registry, never with the signer's word for its key.
 * Of two concurrent calls the store keeps one signature, and the other call
 * answers with that stored signature, never with its own.
 */
export function createSignPendingReceipt(deps: SignPendingReceiptDeps) {
  const { signer, store, checkObject, signTimeoutMs } = deps;
  if (typeof checkObject !== "function") {
    throw new TypeError("signPendingReceipt: checkObject is required");
  }
  if (
    !Number.isSafeInteger(signTimeoutMs) ||
    signTimeoutMs <= 0 ||
    signTimeoutMs > MAX_SIGN_TIMEOUT_MS
  ) {
    throw new RangeError("signPendingReceipt: invalid signTimeoutMs");
  }

  return async function signPendingReceipt(
    row: PendingReceiptRow,
  ): Promise<SignPendingReceiptOutcome> {
    const parsed = parsePendingReceipt(row);
    if (!parsed.ok) return { status: "refused", reason: parsed.reason };
    const { payload } = parsed;

    let digest: Awaited<ReturnType<typeof digestEvidenceReceiptPayloadV2>>;
    try {
      digest = await digestEvidenceReceiptPayloadV2(payload);
    } catch (error) {
      return error instanceof EvidenceHashUnavailableError
        ? { status: "unavailable", stage: "hash", reason: "hash_unavailable" }
        : { status: "refused", reason: "receipt_malformed" };
    }
    if (digest.signingInput.byteLength !== EVIDENCE_RECEIPT_V2_SIGNING_INPUT_BYTES) {
      return { status: "unavailable", stage: "hash", reason: "signing_input_length" };
    }

    let keys: readonly EvidenceDomainKey[];
    try {
      const read = await store.receiptKeys(payload.evidenceDomainId);
      if (read.status !== "ok" || !Array.isArray(read.keys)) {
        return { status: "unavailable", stage: "keys", reason: "keys_unavailable" };
      }
      keys = read.keys;
    } catch {
      return { status: "unavailable", stage: "keys", reason: "keys_unavailable" };
    }

    // Last step before the signer: the object the receipt names is there.
    let object: PendingReceiptObjectCheck;
    try {
      object = await checkObject(payload);
    } catch {
      return { status: "unavailable", stage: "object", reason: "presence_unavailable" };
    }
    const held = objectOutcome(object);
    if (held !== null) return held;

    const signed = await signWithin(signer, digest.signingInput, signTimeoutMs);
    if (!signed.ok) return { status: "unavailable", stage: "signing", reason: signed.reason };

    const own: SignedEvidenceReceiptV2 = {
      payload,
      payloadDigestSha256: digest.sha256,
      signature: signed.signature,
    };
    const check = await verifiedReceipt(own, keys);
    if (!check.ok) {
      return check.reason === EVIDENCE_VERIFICATION_UNAVAILABLE
        ? { status: "unavailable", stage: "verification", reason: check.reason }
        : { status: "signer_rejected", reason: check.reason };
    }

    let attached: AttachReceiptSignatureOutcome;
    try {
      attached = await store.attachSignature({
        receiptId: payload.receiptId,
        payloadDigestSha256: digest.sha256,
        signature: signed.signature,
      });
    } catch {
      return { status: "unavailable", stage: "store", reason: "store_unavailable" };
    }
    return settle(attached, own, keys);
  };
}
