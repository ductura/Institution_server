// S-1E-c (DAN-837): keys behind the outside-service pattern. Invented values only.
import { describe, expect, it } from "vitest";

import type { Result } from "../../domain/index.ts";
import { createExternalCaller } from "../../metrics/index.ts";
import { guardKeys } from "./guarded-keys.ts";
import { kmsTransportError } from "./signing-errors.ts";
import type { SigningKeyProvider } from "./signing-key-provider.ts";

const POLICY = { timeoutMs: 1000, retries: 2, retryDelayMs: 0, downAfter: 9, downForMs: 0 };

function provider(answer: Result<never>) {
  const calls: string[] = [];
  const keys: SigningKeyProvider = {
    sign: async () => (calls.push("sign"), answer),
    verify: async () => (calls.push("verify"), answer),
    publicVerificationKey: async () => (calls.push("key"), answer),
  };
  return { calls, guarded: guardKeys(keys, createExternalCaller("keys", POLICY)) };
}

const ENVELOPE = {
  algorithm: "Ed25519",
  keyId: "k",
  keyVersion: "v",
  encoding: "base64url",
  signature: "AA",
} as const;

describe("guardKeys", () => {
  it("passes the provider's own refusal unchanged and does not retry it", async () => {
    const { calls, guarded } = provider({ ok: false, error: kmsTransportError("access_denied") });
    expect(await guarded.publicVerificationKey()).toEqual({
      ok: false,
      error: kmsTransportError("access_denied"),
    });
    expect(calls).toEqual(["key"]);
  });

  it("signs once and retries verify and the public key on a transport fault", async () => {
    const { calls, guarded } = provider({ ok: false, error: kmsTransportError("network") });
    await guarded.sign(new Uint8Array([1]));
    await guarded.verify(new Uint8Array([1]), ENVELOPE as never);
    await guarded.publicVerificationKey();
    expect(calls).toEqual(["sign", "verify", "verify", "verify", "key", "key", "key"]);
  });

  it("turns a throw into SIGNING_UNAVAILABLE without the thrown text", async () => {
    const keys: SigningKeyProvider = {
      sign: () => Promise.reject(new Error("canary-key-material")),
      verify: async () => ({ ok: true, value: true }),
      publicVerificationKey: () => Promise.reject(new Error("x")),
    };
    const answer = await guardKeys(keys, createExternalCaller("keys", POLICY)).sign(
      new Uint8Array(),
    );
    expect(answer).toEqual({ ok: false, error: kmsTransportError("network") });
    expect(JSON.stringify(answer)).not.toContain("canary");
  });
});
