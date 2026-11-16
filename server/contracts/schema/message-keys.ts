// The one table from an error code to its message key (S-1L.3, DAN-789).
// `code` is the snake_case word on the wire; `messageKey` is the camelCase
// key of its text in locales/ (errors.<camelCase>). Rows are pairs, not
// object keys, so the snake_case codes stay values (naming-convention).
// error() takes the key only from here, so a code without a row cannot be
// declared (server/http/problem.test.ts).
export const ERROR_MESSAGE_KEYS: ReadonlyMap<string, string> = new Map([
  ["bad_request", "errors.badRequest"],
  ["body_stream_error", "errors.bodyStreamError"],
  ["body_timeout", "errors.bodyTimeout"],
  ["body_too_large", "errors.bodyTooLarge"],
  ["bound_crossed", "errors.boundCrossed"],
  ["chain_conflict", "errors.chainConflict"],
  ["content_length_invalid", "errors.contentLengthInvalid"],
  ["content_length_mismatch", "errors.contentLengthMismatch"],
  ["cross_site", "errors.crossSite"],
  ["document_mismatch", "errors.documentMismatch"],
  ["draining", "errors.draining"],
  ["forbidden", "errors.forbidden"],
  ["internal", "errors.internal"],
  ["invalid", "errors.invalid"],
  ["invalid_input", "errors.invalidInput"],
  ["invalid_json", "errors.invalidJson"],
  ["invalid_logout_token", "errors.invalidLogoutToken"],
  ["login_failed", "errors.loginFailed"],
  ["login_refused", "errors.loginRefused"],
  ["method_not_allowed", "errors.methodNotAllowed"],
  ["not_accepting", "errors.notAccepting"],
  ["not_continuous", "errors.notContinuous"],
  ["not_found", "errors.notFound"],
  ["not_started", "errors.notStarted"],
  ["origin_mismatch", "errors.originMismatch"],
  ["origin_missing", "errors.originMissing"],
  ["stale_base", "errors.staleBase"],
  ["timeout", "errors.timeout"],
  ["too_large", "errors.tooLarge"],
  ["too_many_reports", "errors.tooManyReports"],
  ["txid_reused", "errors.txidReused"],
  ["unauthenticated", "errors.unauthenticated"],
  ["unauthorized", "errors.unauthorized"],
  ["unavailable", "errors.unavailable"],
  ["unsupported_media_type", "errors.unsupportedMediaType"],
  ["upgrade_required", "errors.upgradeRequired"],
]);

/** The message key of a code; throws for a code the table does not have. */
export function messageKeyOf(code: string): string {
  const key = ERROR_MESSAGE_KEYS.get(code);
  if (key === undefined) throw new Error(`no message key for ${code}`);
  return key;
}
