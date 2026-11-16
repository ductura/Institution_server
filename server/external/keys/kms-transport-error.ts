// The closed failure classes of the KMS transport, in their own file so the
// signer can recognise them without importing the SDK transport (which
// imports the signer's constants).

export type KmsTransportErrorKind =
  "access_denied" | "key_not_found" | "timeout" | "invalid_response" | "network" | "service_error";

export type KmsTransportOperation = "sign" | "verify" | "getPublicKey";

/**
 * Closed failure classes of the KMS transport (DAN-295 contract, #1091).
 * The message carries no key id or ARN; awsErrorName is the SDK error name
 * when there is one, for logs. The transport is internal and throws it; the
 * signer turns it into a result at the port (docs/CODE_STYLE.md §8).
 */
export class KmsTransportError extends Error {
  readonly kind: KmsTransportErrorKind;
  readonly operation: KmsTransportOperation;
  readonly awsErrorName: string | undefined;

  constructor(
    kind: KmsTransportErrorKind,
    operation: KmsTransportOperation,
    awsErrorName?: string,
  ) {
    super(`aws-kms: ${operation} ${kind}`);
    this.kind = kind;
    this.operation = operation;
    this.awsErrorName = awsErrorName;
    this.name = "KmsTransportError";
  }
}
