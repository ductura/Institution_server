// The signing port. Ported from Ductus src/application/ports/signing-key-provider.ts
// at d52a92c3 (S-0.19, DAN-732); `interface` became `type` (docs/CODE_STYLE.md, rule 4).
// `sign`, `verify` and `publicVerificationKey` return a Result
// (docs/CODE_STYLE.md §8): an expected fault of the key or the KMS is a value
// with a stable code from signing-errors.ts; only programming errors throw.
// `verify` answers `{ ok: true, value: false }` for a signature that does not
// verify, and a failure only when the key or the KMS could not be reached.
import type { PublicVerificationKey, Result, SignatureEnvelope } from "../../domain/index.ts";

/**
 * Provider-neutral evidence/artifact signing boundary.
 *
 * Production implementations are expected to keep private key material in a
 * KMS/HSM. The application receives signatures, never exportable private keys.
 */
export type SigningKeyProvider = {
  sign(message: Uint8Array): Promise<Result<SignatureEnvelope>>;
  verify(message: Uint8Array, signature: SignatureEnvelope): Promise<Result<boolean>>;
  publicVerificationKey(): Promise<Result<PublicVerificationKey>>;
};

export type {
  PublicVerificationKey,
  SignatureAlgorithm,
  SignatureEncoding,
  SignatureEnvelope,
} from "../../domain/index.ts";
