// DAN-820 820c-4c, plan of attack ductura/server#146 P-2, P-5, P-7: the
// signing of a pending receipt against the store's answers. K5, K8, K9 and
// K10 are ported from Ductus sign-pending-receipt.test.ts at 333e163 with the
// same assertions (K8 on a fake clock). Every value is invented.
import { describe, expect, it, vi } from "vitest";

import type { SignatureEnvelope } from "../domain/index.ts";
import {
  RECEIPT,
  ROW,
  memoryStore,
  sha256,
  testSigner,
  TEXT,
} from "../../test-support/pending-receipt/index.ts";

import type { PendingReceiptObjectCheck } from "./object-check.ts";
import { createSignPendingReceipt } from "./sign-pending-receipt.ts";

const present = async (): Promise<PendingReceiptObjectCheck> => ({ status: "present" });
function setup(signer = testSigner("k1"), keys = () => [signer.key()], checkObject = present) {
  const { store, stored } = memoryStore(keys);
  const run = createSignPendingReceipt({
    signer: signer.provider,
    store,
    signTimeoutMs: 1000,
    checkObject,
  });
  return { signer, store, stored, run };
}
const D92 = Buffer.concat([Buffer.from("ductus-evidence-receipt-v2\n"), sha256(TEXT)]);

describe("signPendingReceipt and the store", () => {
  it("K5 an already signed receipt answers with the stored signature, never its own", async () => {
    const first = testSigner("k1");
    const second = testSigner("k2");
    const { store, stored } = memoryStore(() => [first.key(), second.key()]);
    stored.set(RECEIPT, first.envelope(new Uint8Array(D92)));
    const run = createSignPendingReceipt({
      signer: second.provider,
      store,
      signTimeoutMs: 1000,
      checkObject: present,
    });
    const out = await run(ROW);
    expect(out.status).toBe("already_signed");
    expect(
      (out as { signedReceipt: { signature: SignatureEnvelope } }).signedReceipt.signature.keyId,
    ).toBe("k1");
  });

  it("K5 a stored signature that does not verify is not answered", async () => {
    const { stored, run } = setup();
    stored.set(RECEIPT, { algorithm: "Ed25519", keyId: "k1" });
    expect(await run(ROW)).toEqual({
      status: "unavailable",
      stage: "store",
      reason: "stored_signature_unverified",
    });
  });

  it("K8 a timeout answers unavailable and a late signature is never attached", async () => {
    vi.useFakeTimers();
    try {
      let late: (() => void) | undefined;
      let asked!: () => void;
      const signerAsked = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const slow = testSigner(
        "k1",
        (_, honest) =>
          new Promise((resolve) => {
            late = () => resolve(honest());
            asked();
          }),
      );
      const { store, stored } = memoryStore(() => [slow.key()]);
      const run = createSignPendingReceipt({
        signer: slow.provider,
        store,
        signTimeoutMs: 20,
        checkObject: present,
      });
      const pending = run(ROW);
      // The bound starts only after the digest, the keys and the object check.
      await signerAsked;
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toEqual({
        status: "unavailable",
        stage: "signing",
        reason: "sign_timeout",
      });
      late!();
      await vi.runAllTimersAsync();
      expect(store.attachSignature).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("K9 a repeated call answers the first signature and keeps one record", async () => {
    const { stored, run } = setup();
    const first = await run(ROW);
    const second = await run(ROW);
    expect(first.status).toBe("signed");
    expect(second.status).toBe("already_signed");
    expect((second as { signedReceipt: unknown }).signedReceipt).toEqual(
      (first as { signedReceipt: unknown }).signedReceipt,
    );
    expect(stored.size).toBe(1);
  });

  it("K10 a store that throws is unavailable, never signed (P-7)", async () => {
    const { store, run } = setup();
    store.attachSignature.mockRejectedValueOnce(new Error("connection reset"));
    expect(await run(ROW)).toEqual({
      status: "unavailable",
      stage: "store",
      reason: "store_unavailable",
    });
  });

  it("K10 keys that cannot be read stop the call before the signer", async () => {
    const { signer, store, run } = setup();
    store.receiptKeys.mockResolvedValueOnce({ status: "unavailable", reason: "x" } as never);
    store.receiptKeys.mockRejectedValueOnce(new Error("down"));
    for (let i = 0; i < 2; i++) {
      expect(await run(ROW)).toEqual({
        status: "unavailable",
        stage: "keys",
        reason: "keys_unavailable",
      });
    }
    expect(signer.provider.sign).not.toHaveBeenCalled();
  });
});
