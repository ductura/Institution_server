// Stable reason codes of the time-stamp port (docs/CODE_STYLE.md §8, ISTR-2
// step 1). Every expected failure of a request or of a response check maps to
// exactly one code and one message key; the Croatian text is in
// locales/hr.json under `tsa`. The worker (step 3) records the code with the
// gap of the day; it is never shown to a student.

export const TSA_ERROR_CODES = [
  "TSA_DIGEST_INVALID",
  "TSA_CONFIG_INVALID",
  "TSA_ANCHORS_INVALID",
  "TSA_TIMEOUT",
  "TSA_UNAVAILABLE",
  "TSA_HTTP_STATUS",
  "TSA_MALFORMED",
  "TSA_REJECTED",
  "TSA_IMPRINT_ALGORITHM",
  "TSA_IMPRINT_MISMATCH",
  "TSA_NONCE_MISMATCH",
  "TSA_GEN_TIME",
  "TSA_SIGNER_CERTIFICATE_MISSING",
  "TSA_ESS_CERT_ID",
  "TSA_CERTIFICATE_EXPIRED",
  "TSA_EKU",
  "TSA_SIGNATURE",
  "TSA_CHAIN",
] as const;

export type TsaErrorCode = (typeof TSA_ERROR_CODES)[number];

/** An AppError (server/domain/result.ts) whose code is one of TSA_ERROR_CODES. */
export type TsaError = { readonly code: TsaErrorCode; readonly messageKey: string };

export type TsaResult<T> = { ok: true; value: T } | { ok: false; error: TsaError };

/** `TSA_IMPRINT_MISMATCH` → `tsa.imprint_mismatch`. */
export function tsaMessageKey(code: TsaErrorCode): string {
  return `tsa.${code.slice("TSA_".length).toLowerCase()}`;
}

export function tsaError(code: TsaErrorCode): TsaError {
  return { code, messageKey: tsaMessageKey(code) };
}

export function tsaFailure<T>(code: TsaErrorCode): TsaResult<T> {
  return { ok: false, error: tsaError(code) };
}
