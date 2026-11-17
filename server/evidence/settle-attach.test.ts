// DAN-820 820c-3, plan of attack ductura/server#146 P-4, P-5, P-7: the
// store's answer becomes an outcome of signing only once it is checked:
// `signed` must carry the signature sent, `already_signed` only a stored
// signature that the protocol 1 verifier accepts. The K10 table of store
// outcomes is ported from Ductus sign-pending-receipt.test.ts at 333e163,
// asked here of `settle` itself; the other cases are new.
import { describe, expect, it } from "vitest";

import type { AttachReceiptSignatureOutcome } from "../database/index.ts";
import type { SignedEvidenceReceiptV2 } from "../domain/index.ts";
import { OTHER_DOMAIN, testKey } from "../../test-support/pending-receipt/index.ts";

import { settle, type SignPendingReceiptOutcome } from "./settle-attach.ts";

const k1 = testKey("k1");
const k2 = testKey("k2");
const KEYS = [k1.key(), k2.key()];
const own: SignedEvidenceReceiptV2 = await k1.signedReceipt();
const other: SignedEvidenceReceiptV2 = await k2.signedReceipt();
const unavailable = (stage: string, reason: string) => ({ status: "unavailable", stage, reason });

describe("settle never answers an unchecked store reply as signed (P-4, P-5, P-7)", () => {
  // K10, ported: the store's outcome table (the "throws" row is the factory's, 820c-4).
  const storeOutcomes: [AttachReceiptSignatureOutcome, SignPendingReceiptOutcome][] = [
    [{ outcome: "not_found" }, { status: "refused", reason: "not_found" }],
    [{ outcome: "invalid" }, { status: "refused", reason: "invalid" }],
    [{ outcome: "unsupported_schema" }, { status: "refused", reason: "unsupported_schema" }],
    [{ outcome: "digest_mismatch" }, { status: "refused", reason: "digest_mismatch" }],
    [{ outcome: "key_unknown" }, { status: "signer_rejected", reason: "key_unknown" }],
    [{ outcome: "key_scope" }, { status: "signer_rejected", reason: "key_scope" }],
    [{ outcome: "key_revoked" }, { status: "signer_rejected", reason: "key_revoked" }],
    [{ outcome: "key_not_valid" }, { status: "signer_rejected", reason: "key_not_valid" }],
    [
      { outcome: "signed", signature: { algorithm: "Ed25519", keyId: "k9" } },
      unavailable("store", "stored_signature_mismatch") as never,
    ],
    [
      { outcome: "signed", signature: undefined },
      unavailable("store", "stored_signature_mismatch") as never,
    ],
    [{ outcome: "unavailable", reason: "x" }, unavailable("store", "store_unavailable") as never],
    [{ outcome: "something_new" } as never, unavailable("store", "unknown_outcome") as never],
    [null as never, unavailable("store", "unknown_outcome") as never],
    [undefined as never, unavailable("store", "unknown_outcome") as never],
    ["signed" as never, unavailable("store", "unknown_outcome") as never],
    [
      { outcome: { toString: () => "signed" } } as never,
      unavailable("store", "unknown_outcome") as never,
    ],
  ];
  it.each(storeOutcomes)("K10 store outcome %j", async (outcome, expected) => {
    expect(await settle(outcome, own, KEYS)).toEqual(expected);
  });

  // New: the stored signature against the one this call sent.
  it.each<[string, AttachReceiptSignatureOutcome, SignPendingReceiptOutcome]>([
    [
      "signed with another key's signature",
      { outcome: "signed", signature: other.signature },
      unavailable("store", "stored_signature_mismatch") as never,
    ],
    [
      "signed with an extra key in the envelope",
      { outcome: "signed", signature: { ...own.signature, extra: 1 } },
      unavailable("store", "stored_signature_mismatch") as never,
    ],
    [
      "already_signed with a malformed signature",
      { outcome: "already_signed", signature: { algorithm: "Ed25519", keyId: "k1" } },
      unavailable("store", "stored_signature_unverified") as never,
    ],
    [
      "already_signed by a key outside the registry",
      { outcome: "already_signed", signature: testKey("k3").envelope(new Uint8Array(59)) },
      unavailable("store", "stored_signature_unverified") as never,
    ],
    [
      "outcome as an inherited key",
      Object.create({ outcome: "signed", signature: own.signature }) as never,
      unavailable("store", "unknown_outcome") as never,
    ],
  ])("%s", async (_, attached, expected) => {
    expect(await settle(attached, own, KEYS)).toEqual(expected);
  });

  it("already_signed by a key of another domain is not answered", async () => {
    const elsewhere = [k1.key(), k2.key({ evidenceDomainId: OTHER_DOMAIN })];
    expect(
      await settle({ outcome: "already_signed", signature: other.signature }, own, elsewhere),
    ).toEqual(unavailable("store", "stored_signature_unverified"));
  });
});

describe("controls", () => {
  it("signed with the signature sent, in any key order, is the call's own receipt", async () => {
    const reordered = Object.fromEntries(Object.entries(own.signature).reverse());
    expect(await settle({ outcome: "signed", signature: reordered }, own, KEYS)).toEqual({
      status: "signed",
      signedReceipt: own,
    });
  });

  it("K5 already_signed answers the stored signature, never its own", async () => {
    const out = await settle({ outcome: "already_signed", signature: other.signature }, own, KEYS);
    expect(out).toEqual({
      status: "already_signed",
      signedReceipt: { ...own, signature: other.signature },
    });
  });
});
