// Stable codes of the signing port (docs/CODE_STYLE.md §8). Each closed fault
// class of the adapters maps to exactly one code and one message key; the
// Croatian text is in locales/hr.json under `signing`. Programming errors (a
// NODE_ENV guard, a broken precondition) are not here: they still throw.
import type { AppError } from "../../domain/index.ts";
import type { KmsTransportErrorKind } from "./kms-transport-error.ts";
import type { DevelopmentSigningKeyFault } from "./persistent-development-ed25519-signer.ts";

/** A seed fault the port returns; `signing_key_production` is the constructor guard and throws. */
export type DevelopmentSigningKeyResultFault = Exclude<
  DevelopmentSigningKeyFault,
  "signing_key_production"
>;

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** KmsTransportError.kind, one to one. */
export function kmsTransportError(kind: KmsTransportErrorKind): AppError {
  switch (kind) {
    case "access_denied":
      return error("SIGNING_ACCESS_DENIED", "signing.access_denied");
    case "key_not_found":
      return error("SIGNING_KEY_NOT_FOUND", "signing.key_not_found");
    case "timeout":
      return error("SIGNING_TIMEOUT", "signing.timeout");
    case "invalid_response":
      return error("SIGNING_INVALID_RESPONSE", "signing.invalid_response");
    case "network":
      return error("SIGNING_UNAVAILABLE", "signing.unavailable");
    case "service_error":
      return error("SIGNING_SERVICE_ERROR", "signing.service_error");
  }
}

/** GetPublicKey named a key that is not an Ed25519 SIGN_VERIFY key. */
export const SIGNING_KEY_INCOMPATIBLE = error(
  "SIGNING_KEY_INCOMPATIBLE",
  "signing.key_incompatible",
);
/** The alias now points at a key version outside the trusted list. */
export const SIGNING_KEY_NOT_TRUSTED = error("SIGNING_KEY_NOT_TRUSTED", "signing.key_not_trusted");

/** DevelopmentSigningKeyFault, one to one: the code is the fault in upper case. */
export function developmentKeyError(fault: DevelopmentSigningKeyResultFault): AppError {
  switch (fault) {
    case "signing_key_not_configured":
      return error("SIGNING_KEY_NOT_CONFIGURED", "signing.key_not_configured");
    case "signing_key_path_not_absolute":
      return error("SIGNING_KEY_PATH_NOT_ABSOLUTE", "signing.key_path_not_absolute");
    case "signing_key_in_repository":
      return error("SIGNING_KEY_IN_REPOSITORY", "signing.key_in_repository");
    case "signing_key_missing":
      return error("SIGNING_KEY_MISSING", "signing.key_missing");
    case "signing_key_not_regular_file":
      return error("SIGNING_KEY_NOT_REGULAR_FILE", "signing.key_not_regular_file");
    case "signing_key_permissions":
      return error("SIGNING_KEY_PERMISSIONS", "signing.key_permissions");
    case "signing_key_malformed":
      return error("SIGNING_KEY_MALFORMED", "signing.key_malformed");
  }
}

export const KMS_TRANSPORT_ERROR_KINDS: readonly KmsTransportErrorKind[] = [
  "access_denied",
  "key_not_found",
  "timeout",
  "invalid_response",
  "network",
  "service_error",
];

export const DEVELOPMENT_KEY_RESULT_FAULTS: readonly DevelopmentSigningKeyResultFault[] = [
  "signing_key_not_configured",
  "signing_key_path_not_absolute",
  "signing_key_in_repository",
  "signing_key_missing",
  "signing_key_not_regular_file",
  "signing_key_permissions",
  "signing_key_malformed",
];

/** Every error the signing port can return, for the locale test. */
export const SIGNING_ERRORS: readonly AppError[] = [
  ...KMS_TRANSPORT_ERROR_KINDS.map(kmsTransportError),
  SIGNING_KEY_INCOMPATIBLE,
  SIGNING_KEY_NOT_TRUSTED,
  ...DEVELOPMENT_KEY_RESULT_FAULTS.map(developmentKeyError),
];
