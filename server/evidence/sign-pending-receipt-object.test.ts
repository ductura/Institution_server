// DAN-820 820c-4c, plan of attack ductura/server#146 P-6: no receipt is signed
// before its segment object is confirmed (DAN-301), and the object check runs
// last before the signer. C3, C5 and the two concurrency tests are ported from
// Ductus sign-pending-receipt.test.ts at 333e163 with the same assertions; the
// one that ran the real object check is replaced (see its comment). Every value is invented.
import { describe, expect, it, vi } from "vitest";

import type { AttachReceiptSignatureCommand, ReceiptSigner } from "../database/index.ts";
import type { SignatureEnvelope } from "../domain/index.ts";
import {
  PAYLOAD,
  RECEIPT,
  ROW,
  memoryStore,
  testSigner,
  type Behaviour,
} from "../../test-support/pending-receipt/index.ts";

import type { PendingReceiptObjectCheck } from "./object-check.ts";
import { createSignPendingReceipt } from "./sign-pending-receipt.ts";
import type { SignPendingReceiptOutcome } from "./settle-attach.ts";

const present = async (): Promise<PendingReceiptObjectCheck> => ({ status: "present" });
function setup(signer = testSigner("k1"), checkObject: () => Promise<unknown> = present) {
  const { store, stored } = memoryStore(() => [signer.key()]);
  const run = createSignPendingReceipt({
    signer: signer.provider,
    store,
    signTimeoutMs: 1000,
    checkObject: checkObject as never,
  });
  return { signer, store, stored, run };
}

describe("signPendingReceipt and the segment object (P-6)", () => {
  it("C3 the object check gets the parsed payload and runs before the signer", async () => {
    const order: string[] = [];
    const signer = testSigner("k1", (_, honest) => {
      order.push("sign");
      return honest();
    });
    const check = vi.fn(async (): Promise<PendingReceiptObjectCheck> => {
      order.push("check");
      return { status: "present" };
    });
    const { run } = setup(signer, check);
    expect((await run(ROW)).status).toBe("signed");
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]).toEqual([PAYLOAD]);
    expect(order).toEqual(["check", "sign"]);
  });

  it("C5 a refused row never reaches the object check", async () => {
    const check = vi.fn(present);
    const { run } = setup(undefined, check);
    for (const text of ["{", "", 7, `${JSON.stringify(PAYLOAD)}\n`]) {
      await run({ receiptId: RECEIPT, receiptPayloadText: text } as never);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("C5 keys that cannot be read stop the call before the object check", async () => {
    const check = vi.fn(present);
    const { store, run } = setup(undefined, check);
    store.receiptKeys.mockResolvedValueOnce({ status: "unavailable", reason: "x" } as never);
    expect((await run(ROW)).status).toBe("unavailable");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("Istodobnost", () => {
  it.each([
    ["k1", "k2"],
    ["k2", "k1"],
  ])(
    "of two concurrent signatures (%s attaches first) one is stored and both answer it",
    async (firstId, secondId) => {
      // Both signers answer only once both were asked, so both sign before either attaches.
      let asked = 0;
      let release!: () => void;
      const bothAsked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const barrier: Behaviour = async (_, honest) => {
        if (++asked === 2) release();
        await bothAsked;
        return honest();
      };
      const k1 = testSigner("k1", barrier);
      const k2 = testSigner("k2", barrier);
      let turn!: () => void;
      const firstDone = new Promise<void>((resolve) => {
        turn = resolve;
      });
      const gate = async (c: AttachReceiptSignatureCommand) => {
        if (c.signature.keyId === secondId) await firstDone;
      };
      const { store, stored } = memoryStore(() => [k1.key(), k2.key()], gate);
      const original = store.attachSignature.getMockImplementation()!;
      store.attachSignature.mockImplementation(async (c) => {
        const out = await original(c);
        if (c.signature.keyId === firstId) turn();
        return out;
      });
      const runFor = (s: { provider: ReceiptSigner }) =>
        createSignPendingReceipt({
          signer: s.provider,
          store,
          signTimeoutMs: 1000,
          checkObject: present,
        })(ROW);
      const [a, b] = await Promise.all([runFor(k1), runFor(k2)]);
      const byId = { k1: a, k2: b } as Record<string, SignPendingReceiptOutcome>;
      expect(byId[firstId]!.status).toBe("signed");
      expect(byId[secondId]!.status).toBe("already_signed");
      expect(stored.size).toBe(1);
      const kept = stored.get(RECEIPT) as SignatureEnvelope;
      expect(kept.keyId).toBe(firstId);
      for (const out of [a, b]) {
        expect((out as { signedReceipt: { signature: unknown } }).signedReceipt.signature).toEqual(
          kept,
        );
      }
    },
  );

  // Replaces the source's test over the real createCheckPendingReceiptObject
  // and InMemoryEvidencePayloadStore, neither of which is ported (DAN-301).
  // Weaker: it does not prove that the real check keeps no state between
  // overlapping calls; porting the source test is an acceptance item of DAN-301.
  it("two concurrent calls for a receipt whose object is missing both hold and sign nothing", async () => {
    let entered = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkObject = vi.fn(async (): Promise<PendingReceiptObjectCheck> => {
      if (++entered === 2) release();
      await both; // both calls are in the check at once
      return { status: "held", reason: "object_absent" };
    });
    const signer = testSigner("k1");
    const { store, stored } = memoryStore(() => [signer.key()]);
    const run = createSignPendingReceipt({
      signer: signer.provider,
      store,
      signTimeoutMs: 1000,
      checkObject,
    });
    const outs = await Promise.all([run(ROW), run(ROW)]);
    expect(outs).toEqual([
      { status: "held", reason: "object_absent" },
      { status: "held", reason: "object_absent" },
    ]);
    expect(checkObject).toHaveBeenCalledTimes(2);
    expect(checkObject.mock.calls).toEqual([[PAYLOAD], [PAYLOAD]]);
    expect(signer.provider.sign).not.toHaveBeenCalled();
    expect(store.attachSignature).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });
});
