// DAN-820 820c-2, plan of attack ductura/server#146 P-2: the signer answers
// within the bound with an Ed25519 envelope, or the call answers a closed
// reason; a late reply is never read. K7 (the cases that need no verifier)
// and the timeout half of K8 are ported from Ductus sign-pending-receipt.test.ts
// at 333e163 with the same assertions; the Result classes and sameSignature
// are new. Every key and value is invented.
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReceiptSigner } from "../database/index.ts";
import type { SignatureEnvelope } from "../domain/index.ts";

import { MAX_SIGN_TIMEOUT_MS, sameSignature, signWithin } from "./sign-within.ts";

const pair = generateKeyPairSync("ed25519");
const INPUT = new Uint8Array(59).fill(7);
const honest = (input: Uint8Array): SignatureEnvelope => ({
  algorithm: "Ed25519",
  keyId: "k1",
  keyVersion: "1",
  signatureEncoding: "raw",
  signatureBase64Url: nodeSign(null, input, pair.privateKey).toString("base64url"),
});
const signer = (answer: (input: Uint8Array) => unknown) =>
  ({ sign: vi.fn(async (input: Uint8Array) => answer(input)) }) as unknown as ReceiptSigner & {
    sign: ReturnType<typeof vi.fn>;
  };
const run = (answer: (input: Uint8Array) => unknown) => signWithin(signer(answer), INPUT, 1000);

afterEach(() => {
  vi.useRealTimers();
});

describe("signWithin answers a closed reason for every bad reply (P-2)", () => {
  it.each<[string, (input: Uint8Array) => unknown, string]>([
    // K7, ported.
    [
      "throws",
      () => {
        throw new Error("transport down");
      },
      "sign_failed",
    ],
    [
      "answers a bad envelope",
      () => ({ ok: true, value: { algorithm: "Ed25519" } }),
      "signature_malformed",
    ],
    [
      "answers another algorithm",
      (input) => ({
        ok: true,
        value: {
          ...honest(input),
          algorithm: "ECDSA_P256_SHA256",
          signatureEncoding: "ieee-p1363",
        },
      }),
      "signature_malformed",
    ],
    // New: the Result of this repo's port.
    [
      "answers ok: false",
      () => ({ ok: false, error: { code: "KMS_DOWN", messageKey: "x" } }),
      "sign_failed",
    ],
    ["rejects", () => Promise.reject(new Error("no")), "sign_failed"],
    ["answers a bare envelope, not a Result", (input) => honest(input), "signature_malformed"],
    ["answers undefined", () => undefined, "signature_malformed"],
    [
      "answers ok as a string",
      (input) => ({ ok: "true", value: honest(input) }),
      "signature_malformed",
    ],
    ["answers a function", () => () => 1, "signature_malformed"],
    [
      "answers a value that cannot be cloned",
      (input) => ({ ok: true, value: honest(input), f: () => 1 }),
      "signature_malformed",
    ],
    [
      "answers an envelope with an extra key",
      (input) => ({ ok: true, value: { ...honest(input), extra: 1 } }),
      "signature_malformed",
    ],
  ])("a signer that %s", async (_, answer, reason) => {
    expect(await run(answer)).toEqual({ ok: false, reason });
  });

  it("a getter on the reply is read once, by the copy", async () => {
    let reads = 0;
    const out = await run((input) => ({
      get ok() {
        reads += 1;
        return reads === 1;
      },
      value: honest(input),
    }));
    expect(out).toEqual({ ok: true, signature: honest(INPUT) });
    expect(reads).toBe(1);
  });

  it("K8 a signer past the bound answers sign_timeout, and its late reply changes nothing", async () => {
    vi.useFakeTimers();
    let late: (() => void) | undefined;
    const slow = signer(
      (input) =>
        new Promise((resolve) => (late = () => resolve({ ok: true, value: honest(input) }))),
    );
    const pending = signWithin(slow, INPUT, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ ok: false, reason: "sign_timeout" });
    late!();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: false, reason: "sign_timeout" });
    expect(slow.sign).toHaveBeenCalledTimes(1);
  });

  it("a signer just inside the bound is answered", async () => {
    vi.useFakeTimers();
    const slow = signer(
      (input) =>
        new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: honest(input) }), 19)),
    );
    const pending = signWithin(slow, INPUT, 20);
    await vi.advanceTimersByTimeAsync(19);
    expect(await pending).toEqual({ ok: true, signature: honest(INPUT) });
  });
});

describe("controls", () => {
  it("an honest signer answers its envelope, signed over a copy of the input", async () => {
    const honestSigner = signer((input) => ({ ok: true, value: honest(input) }));
    expect(await signWithin(honestSigner, INPUT, 1000)).toEqual({
      ok: true,
      signature: honest(INPUT),
    });
    const given = honestSigner.sign.mock.calls[0]![0] as Uint8Array;
    expect(given).toEqual(INPUT);
    expect(given).not.toBe(INPUT);
  });

  it("the bound is a minute", () => {
    expect(MAX_SIGN_TIMEOUT_MS).toBe(60_000);
  });
});

describe("sameSignature", () => {
  const sent = honest(INPUT);
  it.each<[string, unknown, boolean]>([
    ["the same envelope", { ...sent }, true],
    [
      "the same envelope in another key order",
      Object.fromEntries(Object.entries(sent).reverse()),
      true,
    ],
    ["another signature", { ...sent, signatureBase64Url: "A".repeat(86) }, false],
    ["another key", { ...sent, keyId: "k2" }, false],
    ["no envelope", { ok: true, value: sent }, false],
    ["null", null, false],
    ["a lone surrogate JCS cannot write", { ...sent, keyId: "k\ud800" }, false],
  ])("%s", (_, stored, same) => {
    expect(sameSignature(stored, sent)).toBe(same);
  });
});
