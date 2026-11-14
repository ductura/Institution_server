// The signing port. Ported from Ductus src/application/ports/signing-key-provider.ts
// at d52a92c3 (S-0.19, DAN-732); `interface` became `type` (docs/CODE_STYLE.md, rule 4).
import type { PublicVerificationKey, SignatureEnvelope } from "../../domain/index.ts";

/**
 * Provider-neutral evidence/artifact signing boundary.
 *
 * Production implementations are expected to keep private key material in a
 * KMS/HSM. The application receives signatures, never exportable private keys.
 */
export type SigningKeyProvider = {
  sign(message: Uint8Array): Promise<SignatureEnvelope>;
  verify(message: Uint8Array, signature: SignatureEnvelope): Promise<boolean>;
  publicVerificationKey(): Promise<PublicVerificationKey>;
};

export type {
  PublicVerificationKey,
  SignatureAlgorithm,
  SignatureEncoding,
  SignatureEnvelope,
} from "../../domain/index.ts";
