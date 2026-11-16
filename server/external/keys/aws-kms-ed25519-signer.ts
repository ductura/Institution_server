import type { AppError, Result } from "../../domain/index.ts";
import { decodeEd25519SignatureBase64Url } from "./ed25519-signature-encoding.ts";
import { KmsTransportError } from "./kms-transport-error.ts";
import {
  kmsTransportError,
  SIGNING_KEY_INCOMPATIBLE,
  SIGNING_KEY_NOT_TRUSTED,
} from "./signing-errors.ts";
import type {
  PublicVerificationKey,
  SignatureEnvelope,
  SigningKeyProvider,
} from "./signing-key-provider.ts";

export const AWS_KMS_ED25519_KEY_SPEC = "ECC_NIST_EDWARDS25519" as const; // gitleaks:allow (public AWS KMS key spec name, not a secret)
export const AWS_KMS_SIGN_VERIFY_USAGE = "SIGN_VERIFY" as const;
export const AWS_KMS_ED25519_ALGORITHM = "ED25519_SHA_512" as const;
export const AWS_KMS_RAW_MESSAGE_TYPE = "RAW" as const;
const MAX_KMS_RAW_MESSAGE_BYTES = 4096;

export type AwsKmsEd25519SignResult = {
  keyId: string;
  signingAlgorithm: string;
  signature: Uint8Array;
};

export type AwsKmsEd25519PublicKeyResult = {
  keyId: string;
  keySpec: string;
  keyUsage: string;
  signingAlgorithms: readonly string[];
  publicKeySpkiDer: Uint8Array;
};

export type AwsKmsEd25519Transport = {
  sign(input: {
    keyId: string;
    message: Uint8Array;
    messageType: typeof AWS_KMS_RAW_MESSAGE_TYPE;
    signingAlgorithm: typeof AWS_KMS_ED25519_ALGORITHM;
  }): Promise<AwsKmsEd25519SignResult>;

  verify(input: {
    keyId: string;
    message: Uint8Array;
    signature: Uint8Array;
    messageType: typeof AWS_KMS_RAW_MESSAGE_TYPE;
    signingAlgorithm: typeof AWS_KMS_ED25519_ALGORITHM;
  }): Promise<boolean>;

  getPublicKey(input: { keyId: string }): Promise<AwsKmsEd25519PublicKeyResult>;
};

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function isCompatibleKmsKey(result: AwsKmsEd25519PublicKeyResult): boolean {
  return (
    result.keyId.trim() !== "" &&
    result.keySpec === AWS_KMS_ED25519_KEY_SPEC &&
    result.keyUsage === AWS_KMS_SIGN_VERIFY_USAGE &&
    result.signingAlgorithms.includes(AWS_KMS_ED25519_ALGORITHM) &&
    result.publicKeySpkiDer.byteLength >= 1
  );
}

const failure = (error: AppError): { ok: false; error: AppError } => ({ ok: false, error });

/**
 * Runs a transport call at the port boundary: a classified KmsTransportError
 * becomes its result; anything else (a programming error, an unclassified
 * throw of an injected transport) is not swallowed and rethrows.
 */
async function call<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof KmsTransportError) return failure(kmsTransportError(error.kind));
    throw error;
  }
}

/**
 * Production SigningKeyProvider semantics for an AWS KMS Ed25519 key.
 *
 * The transport is intentionally injected. Production composition should use
 * the official AWS KMS SDK; this module does not hand-roll AWS SigV4.
 *
 * Receipt bytes are supplied as RAW input to ED25519_SHA_512 as required for
 * ECC_NIST_EDWARDS25519 KMS keys. keyVersion stores the concrete KMS KeyId/ARN
 * returned by Sign, so historical verification never follows a rotated alias.
 *
 * trustedKeyVersions lists the concrete KMS key ARNs this provider may sign
 * with or verify against (current and historical, from the signing_key
 * registry). keyVersion inside an envelope is untrusted input: without this
 * allowlist a signature from any other key the transport can Verify with
 * would pass.
 */
export class AwsKmsEd25519SigningKeyProvider implements SigningKeyProvider {
  private readonly transport: AwsKmsEd25519Transport;
  private readonly configuredKeyId: string;

  constructor(
    transport: AwsKmsEd25519Transport,
    configuredKeyId: string,
    trustedKeyVersions: readonly string[],
  ) {
    this.transport = transport;
    this.configuredKeyId = configuredKeyId;
    if (!configuredKeyId.trim()) {
      throw new Error("aws-kms: key id required");
    }
    this.trustedKeyVersions = new Set(trustedKeyVersions.filter((version) => version.trim()));
    if (this.trustedKeyVersions.size === 0) {
      throw new Error("aws-kms: trusted key versions required");
    }
  }

  private readonly trustedKeyVersions: ReadonlySet<string>;

  async sign(message: Uint8Array): Promise<Result<SignatureEnvelope>> {
    // A precondition of the caller (receipt bytes are always within KMS's
    // RAW limit), so a programming error that throws (§8).
    if (message.byteLength < 1 || message.byteLength > MAX_KMS_RAW_MESSAGE_BYTES) {
      throw new Error("aws-kms: raw message size unsupported");
    }

    const signed = await call(() =>
      this.transport.sign({
        keyId: this.configuredKeyId,
        message,
        messageType: AWS_KMS_RAW_MESSAGE_TYPE,
        signingAlgorithm: AWS_KMS_ED25519_ALGORITHM,
      }),
    );
    if (!signed.ok) return signed;
    const result = signed.value;

    if (
      !result.keyId.trim() ||
      result.signingAlgorithm !== AWS_KMS_ED25519_ALGORITHM ||
      result.signature.byteLength < 1
    ) {
      return failure(kmsTransportError("invalid_response"));
    }
    if (!this.trustedKeyVersions.has(result.keyId)) {
      return failure(SIGNING_KEY_NOT_TRUSTED);
    }

    return {
      ok: true,
      value: {
        algorithm: "Ed25519",
        keyId: this.configuredKeyId,
        keyVersion: result.keyId,
        signatureEncoding: "raw",
        signatureBase64Url: toBase64Url(result.signature),
      },
    };
  }

  /**
   * A signature that does not verify, or one outside the trusted versions, is
   * `{ ok: true, value: false }`; a classified transport fault is its result
   * (docs/CODE_STYLE.md §8), not a quiet false: the KMS gave no answer.
   */
  async verify(message: Uint8Array, signature: SignatureEnvelope): Promise<Result<boolean>> {
    const invalid = { ok: true, value: false } as const;
    if (
      signature.algorithm !== "Ed25519" ||
      signature.signatureEncoding !== "raw" ||
      signature.keyId !== this.configuredKeyId ||
      !this.trustedKeyVersions.has(signature.keyVersion)
    ) {
      return invalid;
    }

    // Strictly decoded first: a malformed encoding is not verified and never
    // reaches KMS.
    const decoded = decodeEd25519SignatureBase64Url(signature.signatureBase64Url);
    if (!decoded) return invalid;
    const bytes = new Uint8Array(decoded);

    return call(() =>
      this.transport.verify({
        // Verify against the exact key version/ARN that signed the receipt,
        // not a possibly rotated alias.
        keyId: signature.keyVersion,
        message,
        signature: bytes,
        messageType: AWS_KMS_RAW_MESSAGE_TYPE,
        signingAlgorithm: AWS_KMS_ED25519_ALGORITHM,
      }),
    );
  }

  async publicVerificationKey(): Promise<Result<PublicVerificationKey>> {
    const fetched = await call(() =>
      this.transport.getPublicKey({
        keyId: this.configuredKeyId,
      }),
    );
    if (!fetched.ok) return fetched;
    const result = fetched.value;
    if (!isCompatibleKmsKey(result)) return failure(SIGNING_KEY_INCOMPATIBLE);
    if (!this.trustedKeyVersions.has(result.keyId)) {
      return failure(SIGNING_KEY_NOT_TRUSTED);
    }

    return {
      ok: true,
      value: {
        algorithm: "Ed25519",
        keyId: this.configuredKeyId,
        keyVersion: result.keyId,
        encoding: "spki-der",
        keyBase64Url: toBase64Url(result.publicKeySpkiDer),
      },
    };
  }
}
