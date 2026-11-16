// DAN-827 (S-1D-a): the state of a session (contract on Ductus#1836,
// c.6914672657). The database derives it from the existing columns of
// identity.session in identity.session_state; this file holds the closed lists
// and reads that function's row. "in_progress" (login started, session not yet
// issued) is defined here but never derived: the login state lives in a
// cookie, and a session row exists only once the session is issued.
import type { AppError, Result } from "../domain/index.ts";

export const SESSION_STATES = Object.freeze([
  "in_progress",
  "active",
  "interrupted",
  "ended",
] as const);

/** Reasons of an interruption: idleness and a change of institution among them. */
export const INTERRUPTED_REASONS = Object.freeze([
  "idle",
  "institution_changed",
  "issuer_removed",
  "operator",
  "superseded",
] as const);

/** Reasons of an ordinary end: a logout of any kind or the absolute expiry. */
export const ENDED_REASONS = Object.freeze([
  "logout",
  "logout_all",
  "backchannel_logout",
  "expired",
] as const);

export type InterruptedReason = (typeof INTERRUPTED_REASONS)[number];
export type EndedReason = (typeof ENDED_REASONS)[number];

export type SessionState =
  | { state: "in_progress" | "active"; reason: null }
  | { state: "interrupted"; reason: InterruptedReason }
  | { state: "ended"; reason: EndedReason };

const INVALID: AppError = Object.freeze({
  code: "SESSION_STATE_INVALID",
  messageKey: "errors.internal",
});

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** Own data property of a plain object, never an inherited one or a getter. */
function ownValue(row: object, key: string): { found: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined || !("value" in descriptor))
    return { found: false, value: undefined };
  return { found: true, value: descriptor.value };
}

/**
 * Reads one row of identity.session_state: a plain object with exactly the
 * own columns `state` and `reason`, each an exact value of its closed list.
 * Anything else is SESSION_STATE_INVALID; no value is trimmed or normalised.
 */
export function parseSessionState(row: unknown): Result<SessionState> {
  const fail = { ok: false, error: INVALID } as const;
  if (typeof row !== "object" || row === null) return fail;
  const proto: unknown = Object.getPrototypeOf(row);
  if (proto !== Object.prototype && proto !== null) return fail;
  const keys = Reflect.ownKeys(row);
  if (keys.length !== 2 || !keys.includes("state") || !keys.includes("reason")) return fail;
  const state = ownValue(row, "state");
  const reason = ownValue(row, "reason");
  if (!state.found || !reason.found) return fail;

  if ((state.value === "active" || state.value === "in_progress") && reason.value === null) {
    return { ok: true, value: { state: state.value, reason: null } };
  }
  if (state.value === "interrupted" && isOneOf(INTERRUPTED_REASONS, reason.value)) {
    return { ok: true, value: { state: "interrupted", reason: reason.value } };
  }
  if (state.value === "ended" && isOneOf(ENDED_REASONS, reason.value)) {
    return { ok: true, value: { state: "ended", reason: reason.value } };
  }
  return fail;
}
