import { describe, expect, it } from "vitest";

import {
  AWS_KMS_ED25519_ALGORITHM,
  AWS_KMS_ED25519_KEY_SPEC,
  AWS_KMS_RAW_MESSAGE_TYPE,
  AWS_KMS_SIGN_VERIFY_USAGE,
  AwsKmsEd25519SigningKeyProvider,
  type AwsKmsEd25519PublicKeyResult,
  type AwsKmsEd25519Transport,
} from "./aws-kms-ed25519-signer.ts";
import { KmsTransportError, type KmsTransportErrorKind } from "./kms-transport-error.ts";

class FakeTransport implements AwsKmsEd25519Transport {
  readonly calls: Array<Record<string, unknown>> = [];
  valid = true;

  async sign(input: Parameters<AwsKmsEd25519Transport["sign"]>[0]) {
    this.calls.push({ kind: "sign", ...input });
    return {
      keyId: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
      signingAlgorithm: AWS_KMS_ED25519_ALGORITHM,
      signature: new Uint8Array([1, 2, 3, 4]),
    };
  }

  async verify(input: Parameters<AwsKmsEd25519Transport["verify"]>[0]) {
    this.calls.push({ kind: "verify", ...input });
    return this.valid;
  }

  async getPublicKey(
    input: Parameters<AwsKmsEd25519Transport["getPublicKey"]>[0],
  ): Promise<AwsKmsEd25519PublicKeyResult> {
    this.calls.push({ kind: "getPublicKey", ...input });
    return {
      keyId: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
      keySpec: AWS_KMS_ED25519_KEY_SPEC,
      keyUsage: AWS_KMS_SIGN_VERIFY_USAGE,
      signingAlgorithms: [AWS_KMS_ED25519_ALGORITHM],
      publicKeySpkiDer: new Uint8Array([48, 42, 1, 2, 3]),
    };
  }
}

const CONCRETE = "arn:aws:kms:eu-central-1:123:key/concrete-v1";
const TRUSTED = [CONCRETE];

describe("AwsKmsEd25519SigningKeyProvider", () => {
  it("uses RAW ED25519_SHA_512 and pins the concrete signing key version", async () => {
    const transport = new FakeTransport();
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);
    const message = new TextEncoder().encode("receipt");

    const signature = {
      algorithm: "Ed25519" as const,
      keyId: "alias/ductus-evidence",
      keyVersion: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
      signatureEncoding: "raw" as const,
      signatureBase64Url: "AQIDBA",
    };
    expect(await signer.sign(message)).toEqual({ ok: true, value: signature });

    expect(transport.calls[0]).toMatchObject({
      kind: "sign",
      keyId: "alias/ductus-evidence",
      messageType: AWS_KMS_RAW_MESSAGE_TYPE,
      signingAlgorithm: AWS_KMS_ED25519_ALGORITHM,
    });

    expect(await signer.verify(message, signature)).toBe(true);
    expect(transport.calls[1]).toMatchObject({
      kind: "verify",
      keyId: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
      messageType: AWS_KMS_RAW_MESSAGE_TYPE,
      signingAlgorithm: AWS_KMS_ED25519_ALGORITHM,
    });
  });

  it("exports SPKI verification material only for the required Ed25519 signing key shape", async () => {
    const transport = new FakeTransport();
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);

    await expect(signer.publicVerificationKey()).resolves.toEqual({
      ok: true,
      value: {
        algorithm: "Ed25519",
        keyId: "alias/ductus-evidence",
        keyVersion: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
        encoding: "spki-der",
        keyBase64Url: "MCoBAgM",
      },
    });
  });

  it("fails closed on incompatible KMS metadata and invalid signatures", async () => {
    const transport = new FakeTransport();
    transport.getPublicKey = async () => ({
      keyId: "bad",
      keySpec: "ECC_NIST_P256",
      keyUsage: AWS_KMS_SIGN_VERIFY_USAGE,
      signingAlgorithms: [AWS_KMS_ED25519_ALGORITHM],
      publicKeySpkiDer: new Uint8Array([1]),
    });
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);

    await expect(signer.publicVerificationKey()).resolves.toEqual({
      ok: false,
      error: { code: "SIGNING_KEY_INCOMPATIBLE", messageKey: "signing.key_incompatible" },
    });

    const validTransport = new FakeTransport();
    validTransport.valid = false;
    const verifier = new AwsKmsEd25519SigningKeyProvider(
      validTransport,
      "alias/ductus-evidence",
      TRUSTED,
    );
    expect(
      await verifier.verify(new Uint8Array([1]), {
        algorithm: "Ed25519",
        keyId: "alias/ductus-evidence",
        keyVersion: "arn:aws:kms:eu-central-1:123:key/concrete-v1",
        signatureEncoding: "raw",
        signatureBase64Url: "AQIDBA",
      }),
    ).toBe(false);
  });

  it("rejects raw messages outside the AWS KMS Sign size boundary", async () => {
    const signer = new AwsKmsEd25519SigningKeyProvider(
      new FakeTransport(),
      "alias/ductus-evidence",
      TRUSTED,
    );
    await expect(signer.sign(new Uint8Array(4097))).rejects.toThrow("raw message size unsupported");
  });

  it("rejects signatures whose key version is not a trusted version of the configured key", async () => {
    const transport = new FakeTransport();
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);
    // The transport would verify this, so only the allowlist can reject it.
    expect(
      await signer.verify(new Uint8Array([1]), {
        algorithm: "Ed25519",
        keyId: "alias/ductus-evidence",
        keyVersion: "arn:aws:kms:eu-central-1:123:key/other-key",
        signatureEncoding: "raw",
        signatureBase64Url: "AQIDBA",
      }),
    ).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it("keeps verifying a historical version after rotation and refuses to sign with an untrusted one", async () => {
    const rotated = "arn:aws:kms:eu-central-1:123:key/rotated-v2";
    const transport = new FakeTransport();
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", [
      rotated,
      CONCRETE,
    ]);
    const message = new TextEncoder().encode("receipt");
    const old = {
      algorithm: "Ed25519" as const,
      keyId: "alias/ductus-evidence",
      keyVersion: CONCRETE,
      signatureEncoding: "raw" as const,
      signatureBase64Url: "AQIDBA",
    };
    expect(await signer.verify(message, old)).toBe(true);

    const onlyRotated = new AwsKmsEd25519SigningKeyProvider(
      new FakeTransport(),
      "alias/ductus-evidence",
      [rotated],
    );
    await expect(onlyRotated.sign(message)).resolves.toEqual({
      ok: false,
      error: { code: "SIGNING_KEY_NOT_TRUSTED", messageKey: "signing.key_not_trusted" },
    });
    expect(
      () => new AwsKmsEd25519SigningKeyProvider(new FakeTransport(), "alias/ductus-evidence", []),
    ).toThrow("trusted key versions required");
  });
  it("returns each classified transport fault as its result at the port, one code per kind", async () => {
    const codes: Array<[KmsTransportErrorKind, string]> = [
      ["access_denied", "SIGNING_ACCESS_DENIED"],
      ["key_not_found", "SIGNING_KEY_NOT_FOUND"],
      ["timeout", "SIGNING_TIMEOUT"],
      ["invalid_response", "SIGNING_INVALID_RESPONSE"],
      ["network", "SIGNING_UNAVAILABLE"],
      ["service_error", "SIGNING_SERVICE_ERROR"],
    ];
    for (const [kind, code] of codes) {
      const transport = new FakeTransport();
      transport.sign = async () => {
        throw new KmsTransportError(kind, "sign");
      };
      transport.getPublicKey = async () => {
        throw new KmsTransportError(kind, "getPublicKey");
      };
      const signer = new AwsKmsEd25519SigningKeyProvider(
        transport,
        "alias/ductus-evidence",
        TRUSTED,
      );
      const signed = await signer.sign(new Uint8Array([1]));
      const key = await signer.publicVerificationKey();
      expect(signed.ok ? null : signed.error.code, kind).toBe(code);
      expect(key.ok ? null : key.error.code, kind).toBe(code);
    }
  });

  it("returns an invalid Sign answer as SIGNING_INVALID_RESPONSE", async () => {
    const transport = new FakeTransport();
    transport.sign = async () => ({
      keyId: CONCRETE,
      // A Sign answer of the wrong algorithm, as an injected transport may give.
      signingAlgorithm: "ECDSA_SHA_256" as typeof AWS_KMS_ED25519_ALGORITHM,
      signature: new Uint8Array([1]),
    });
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);
    await expect(signer.sign(new Uint8Array([1]))).resolves.toEqual({
      ok: false,
      error: { code: "SIGNING_INVALID_RESPONSE", messageKey: "signing.invalid_response" },
    });
  });

  it("does not swallow an unclassified throw of the transport", async () => {
    const transport = new FakeTransport();
    transport.sign = async () => {
      throw new TypeError("programming error");
    };
    transport.getPublicKey = async () => {
      throw new TypeError("programming error");
    };
    const signer = new AwsKmsEd25519SigningKeyProvider(transport, "alias/ductus-evidence", TRUSTED);
    await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow(TypeError);
    await expect(signer.publicVerificationKey()).rejects.toThrow(TypeError);
  });
});
