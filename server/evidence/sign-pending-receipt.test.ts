// DAN-820 820c-4b, plan of attack ductura/server#146 P-1 … P-8: one pending
// receipt v2 is signed only after its text, the domain's keys and its object
// are checked, and is stored only once the protocol 1 verifier accepts the
// signature with a key of the domain's registry. Ported from Ductus
// sign-pending-receipt.test.ts at 333e163 with the same assertions; the
// tables of the parts 820c-1 … 820c-4a are there, and K5, K8, K9, K10 come
// with 820c-4c. Every value is invented.
import { describe, expect, it, vi } from "vitest";

import {
  verifySignedEvidenceReceiptV2,
  type EvidenceDomainKey,
  type SignatureEnvelope,
} from "../domain/index.ts";
import {
  DOMAIN,
  OTHER_DOMAIN,
  PAYLOAD,
  RECEIPT,
  ROW,
  TEXT,
  memoryStore,
  sha256,
  testSigner,
  type Behaviour,
} from "../../test-support/pending-receipt/index.ts";

import type { PendingReceiptObjectCheck } from "./object-check.ts";
import { createSignPendingReceipt } from "./sign-pending-receipt.ts";
import type { SignPendingReceiptOutcome } from "./settle-attach.ts";

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
const expectation = {
  documentId: "doc-1",
  clientTransactionId: "tx-1",
  revision: 1,
  evidenceDomainId: DOMAIN,
};

describe("signPendingReceipt", () => {
  it("K1 signs exactly the 59 D-92 bytes and stores a signature the registry key verifies", async () => {
    const { signer, stored, run } = setup();
    const out = await run(ROW);
    expect(out.status).toBe("signed");
    expect(signer.inputs).toHaveLength(1);
    expect(signer.inputs[0]!.byteLength).toBe(59);
    expect(Buffer.from(signer.inputs[0]!).equals(D92)).toBe(true);
    const signed = (out as Extract<SignPendingReceiptOutcome, { status: "signed" }>).signedReceipt;
    expect(signed.payloadDigestSha256).toBe(sha256(TEXT).toString("hex"));
    expect(stored.get(RECEIPT)).toEqual(signed.signature);
    expect((await verifySignedEvidenceReceiptV2(signed, expectation, [signer.key()])).ok).toBe(
      true,
    );
  });

  it("a refused text never reaches the signer or the store (P-1)", async () => {
    const { signer, store, run } = setup();
    expect(await run({ receiptId: RECEIPT, receiptPayloadText: "{" })).toEqual({
      status: "refused",
      reason: "receipt_malformed",
    });
    expect(signer.provider.sign).not.toHaveBeenCalled();
    expect(store.attachSignature).not.toHaveBeenCalled();
  });

  const scopes: [string, Partial<EvidenceDomainKey> | null, string][] = [
    ["of another domain", { evidenceDomainId: OTHER_DOMAIN }, "key_scope"],
    ["for checkpoints", { purpose: "checkpoint" as never }, "key_scope"],
    ["revoked", { revokedAt: "2026-10-01T00:00:00.000Z" }, "key_revoked"],
    ["retired before acceptance", { validTo: "2026-10-01T00:00:00.000Z" }, "key_not_valid"],
    ["missing from the registry", null, "key_unknown"],
  ];
  it.each(scopes)(
    "K6 a signer key %s is rejected and nothing is attached (P-3)",
    async (_, scope, reason) => {
      const signer = testSigner("k1");
      const { store, stored, run } = setup(signer, () =>
        scope === null ? [] : [signer.key(scope)],
      );
      expect(await run(ROW)).toEqual({ status: "signer_rejected", reason });
      expect(store.attachSignature).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
    },
  );

  const faults: [string, Behaviour, SignPendingReceiptOutcome][] = [
    [
      "throws",
      () => {
        throw new Error("transport down");
      },
      { status: "unavailable", stage: "signing", reason: "sign_failed" },
    ],
    [
      "answers a bad envelope",
      () => ({ algorithm: "Ed25519" }),
      { status: "unavailable", stage: "signing", reason: "signature_malformed" },
    ],
    [
      "answers another algorithm",
      (_, honest) => ({
        ...honest(),
        algorithm: "ECDSA_P256_SHA256",
        signatureEncoding: "ieee-p1363",
      }),
      { status: "unavailable", stage: "signing", reason: "signature_malformed" },
    ],
    [
      "signs other bytes",
      (input, honest) => {
        input[58] = (input[58]! + 1) % 256;
        return honest();
      },
      { status: "signer_rejected", reason: "signature_invalid" },
    ],
  ];
  it.each(faults)("K7 a signer that %s changes nothing (P-2)", async (_, behave, expected) => {
    const { store, stored, run } = setup(testSigner("k1", behave));
    expect(await run(ROW)).toEqual(expected);
    expect(store.attachSignature).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it("refuses a timeout that is not a positive bound (P-8)", () => {
    const { signer, store } = setup();
    for (const ms of [0, -1, 1.5, Number.NaN, 60_001]) {
      expect(() =>
        createSignPendingReceipt({
          signer: signer.provider,
          store,
          signTimeoutMs: ms,
          checkObject: present,
        }),
      ).toThrow(RangeError);
    }
  });

  it("C4 a signer without an object check is not built", () => {
    const { signer, store } = setup();
    for (const checkObject of [undefined, null, {}, "present"]) {
      expect(() =>
        createSignPendingReceipt({
          signer: signer.provider,
          store,
          signTimeoutMs: 1000,
          checkObject,
        } as never),
      ).toThrow(TypeError);
    }
  });

  // Codex review of #211: the object guard of the factory itself, not only
  // objectOutcome. C1 and C2 of the source, through the factory (P-6).
  const unsigned: [string, () => Promise<unknown>, SignPendingReceiptOutcome][] = [
    ...(["not_pending", "locator_mismatch", "object_absent", "object_mismatch"] as const).map(
      (reason): [string, () => Promise<unknown>, SignPendingReceiptOutcome] => [
        `held as ${reason}`,
        async () => ({ status: "held", reason }),
        { status: "held", reason },
      ],
    ),
    [
      "unavailable",
      async () => ({ status: "unavailable", reason: "locator_unavailable" }),
      { status: "unavailable", stage: "object", reason: "locator_unavailable" },
    ],
    [
      "throws",
      async () => {
        throw new Error("down");
      },
      { status: "unavailable", stage: "object", reason: "presence_unavailable" },
    ],
    [
      "answers null",
      async () => null,
      { status: "unavailable", stage: "object", reason: "presence_unavailable" },
    ],
  ];
  it.each(unsigned)(
    "C1, C2 an object check that is %s signs and stores nothing",
    async (_, check, expected) => {
      const { signer, store, stored, run } = setup(undefined, undefined, check as never);
      expect(await run(ROW)).toEqual(expected);
      expect(signer.provider.sign).not.toHaveBeenCalled();
      expect(store.attachSignature).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
    },
  );

  it("a check that never settles never lets the signer run", async () => {
    const { signer, store, run } = setup(undefined, undefined, () => new Promise<never>(() => {}));
    void run(ROW);
    await new Promise((resolve) => setImmediate(resolve));
    expect(signer.provider.sign).not.toHaveBeenCalled();
    expect(store.attachSignature).not.toHaveBeenCalled();
  });
});
