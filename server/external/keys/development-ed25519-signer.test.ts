import { describe, expect, it, vi } from "vitest";

import { DevelopmentEd25519SigningKeyProvider } from "./development-ed25519-signer.ts";

describe("DevelopmentEd25519SigningKeyProvider", () => {
  it("signs and verifies exact bytes with stable public-key metadata", async () => {
    const signer = new DevelopmentEd25519SigningKeyProvider("dev-key", "v7");
    const bytes = new TextEncoder().encode("Pisač evidence receipt");
    const signed = await signer.sign(bytes);
    if (!signed.ok) throw new Error(`expected ok, got ${signed.error.code}`);
    const signature = signed.value;

    expect(signature).toMatchObject({
      algorithm: "Ed25519",
      keyId: "dev-key",
      keyVersion: "v7",
    });
    expect(signature.signatureBase64Url.length).toBeGreaterThan(40);
    expect(await signer.verify(bytes, signature)).toEqual({ ok: true, value: true });

    const tampered = new TextEncoder().encode("Pisač evidence receipt!");
    expect(await signer.verify(tampered, signature)).toEqual({ ok: true, value: false });
    expect(await signer.verify(bytes, { ...signature, keyVersion: "v8" })).toEqual({
      ok: true,
      value: false,
    });

    expect(await signer.publicVerificationKey()).toMatchObject({
      ok: true,
      value: { algorithm: "Ed25519", keyId: "dev-key", keyVersion: "v7", encoding: "spki-der" },
    });
  });

  // F-020: an allowlist, so an unset, empty or misspelt NODE_ENV is production.
  it.each([undefined, "", "Production", "production ", "staging", "prod"])(
    "refuses construction when NODE_ENV is %j",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      try {
        expect(() => new DevelopmentEd25519SigningKeyProvider()).toThrow(
          "prohibited in production",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["development", "test"])("may be constructed when NODE_ENV is %s", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    try {
      expect(new DevelopmentEd25519SigningKeyProvider()).toBeInstanceOf(
        DevelopmentEd25519SigningKeyProvider,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses construction in production mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => new DevelopmentEd25519SigningKeyProvider()).toThrow("prohibited in production");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
