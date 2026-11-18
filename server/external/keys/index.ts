// Public interface of the signing and key adapters (KMS, D-71). Other areas
// import from here, never from the files next to it; areas other than `http`
// import it with `import type` only (docs/server-map.md §2). Ported from
// Ductus src/adapters/crypto at d52a92c3 (S-0.19, DAN-732).
export type {
  PublicVerificationKey,
  SignatureAlgorithm,
  SignatureEncoding,
  SignatureEnvelope,
  SigningKeyProvider,
} from "./signing-key-provider.ts";
export {
  AWS_KMS_ED25519_ALGORITHM,
  AWS_KMS_ED25519_KEY_SPEC,
  AWS_KMS_RAW_MESSAGE_TYPE,
  AWS_KMS_SIGN_VERIFY_USAGE,
  AwsKmsEd25519SigningKeyProvider,
  type AwsKmsEd25519PublicKeyResult,
  type AwsKmsEd25519SignResult,
  type AwsKmsEd25519Transport,
} from "./aws-kms-ed25519-signer.ts";
export {
  AwsSdkKmsEd25519Transport,
  KmsTransportError,
  type KmsCommandSender,
  type KmsTransportErrorKind,
  type KmsTransportOperation,
} from "./aws-kms-sdk-transport.ts";
export {
  DEVELOPMENT_KEY_RESULT_FAULTS,
  developmentKeyError,
  KMS_TRANSPORT_ERROR_KINDS,
  kmsTransportError,
  SIGNING_ERRORS,
  SIGNING_KEY_INCOMPATIBLE,
  SIGNING_KEY_NOT_TRUSTED,
  type DevelopmentSigningKeyResultFault,
} from "./signing-errors.ts";
export { DevelopmentEd25519SigningKeyProvider } from "./development-ed25519-signer.ts";
export {
  DEV_SIGNING_KEY_FILE,
  DevelopmentSigningKeyError,
  developmentKeyIdentity,
  developmentSeedPath,
  PersistentDevelopmentEd25519SigningKeyProvider,
  type DevelopmentSigningKeyFault,
} from "./persistent-development-ed25519-signer.ts";
export {
  awsKmsSigningKeyProvider,
  KMS_CALL_TIMEOUT_MS,
  type KmsClientFactory,
} from "./kms-signer-from-settings.ts";
