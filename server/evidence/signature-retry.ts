// The decision after one attempt to sign a pending receipt v2 (DAN-822-1,
// VS-1b part 3). Port of `signatureRetryDelayMs`, `decideSignatureRetry`, the
// policy and its caps from Ductus src/application/evidence/signature-retry.ts
// at b36c82b, word for word. The loop that runs the attempts and waits
// (`createSignPendingReceiptWithRetry`) comes in 822-2.
import { isPlainObject } from "../domain/index.ts";

import type { SignPendingReceiptOutcome } from "./settle-attach.ts";

export const MAX_SIGNATURE_RETRY_ATTEMPTS = 10;
export const MAX_SIGNATURE_RETRY_DELAY_MS = 300_000;

export type SignatureRetryPolicy = {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Ceiling of the first wait; it doubles after every attempt. */
  baseDelayMs: number;
  /** No wait is longer. */
  maxDelayMs: number;
};

/** Why a receipt is left in `pending_signature` for the reconciler or an operator. */
export type SignatureParkReason =
  | "refused"
  | "held"
  | "signer_rejected"
  | "hash"
  | "exhausted"
  /** The wait of the loop (822-2) was ended: shutdown or abort. */
  | "interrupted";

export type SignatureRetryDecision =
  | { action: "done" }
  | { action: "retry"; delayMs: number }
  | { action: "park"; reason: SignatureParkReason };

type Signed = Extract<SignPendingReceiptOutcome, { status: "signed" | "already_signed" }>;

const TERMINAL: ReadonlySet<unknown> = new Set(["refused", "held", "signer_rejected"]);

function isSafeIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function assertPolicy(policy: unknown): asserts policy is SignatureRetryPolicy {
  if (
    !isPlainObject(policy) ||
    !isSafeIn(policy.maxAttempts, 1, MAX_SIGNATURE_RETRY_ATTEMPTS) ||
    !isSafeIn(policy.maxDelayMs, 1, MAX_SIGNATURE_RETRY_DELAY_MS) ||
    !isSafeIn(policy.baseDelayMs, 1, policy.maxDelayMs)
  ) {
    throw new RangeError("signatureRetry: invalid policy");
  }
}

/**
 * The wait after attempt `attempt`: a value in [ceiling / 2, ceiling], where
 * the ceiling is `baseDelayMs * 2^(attempt - 1)` capped at `maxDelayMs`. An
 * attempt outside [1, 10] counts as step 10. An unusable random value waits
 * the whole ceiling, never less and never 0.
 */
export function signatureRetryDelayMs(
  attempt: number,
  policy: SignatureRetryPolicy,
  random: number,
): number {
  assertPolicy(policy);
  const step = isSafeIn(attempt, 1, MAX_SIGNATURE_RETRY_ATTEMPTS)
    ? attempt - 1
    : MAX_SIGNATURE_RETRY_ATTEMPTS;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** step);
  if (typeof random !== "number" || !(random >= 0 && random < 1)) return ceiling;
  const floor = Math.ceil(ceiling / 2);
  return Math.min(ceiling, floor + Math.floor(random * (ceiling - floor + 1)));
}

function isSigned(reply: unknown): reply is Signed {
  return (
    isPlainObject(reply) &&
    (reply.status === "signed" || reply.status === "already_signed") &&
    isPlainObject(reply.signedReceipt)
  );
}

/**
 * What to do with the reply of attempt `attempt` (1-based). Only a signed
 * receipt is done. A refusal, a hold, a signer the registry rejects and a
 * failure of hashing are not fixed by waiting, so they park at once. Every
 * other reply, an unknown one included, is transient until the attempts run
 * out. A parked receipt stays pending; nothing here writes a signature.
 */
export function decideSignatureRetry(
  reply: unknown,
  attempt: number,
  policy: SignatureRetryPolicy,
  random: number,
): SignatureRetryDecision {
  assertPolicy(policy);
  if (isSigned(reply)) return { action: "done" };
  const status = isPlainObject(reply) ? reply.status : undefined;
  if (TERMINAL.has(status)) {
    return { action: "park", reason: status as "refused" | "held" | "signer_rejected" };
  }
  if (status === "unavailable" && isPlainObject(reply) && reply.stage === "hash") {
    return { action: "park", reason: "hash" };
  }
  if (!isSafeIn(attempt, 1, policy.maxAttempts - 1)) return { action: "park", reason: "exhausted" };
  return { action: "retry", delayMs: signatureRetryDelayMs(attempt, policy, random) };
}
