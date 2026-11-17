// DAN-822-1: the bounds of the retry decision hold for every valid policy,
// whatever the attempt number and the random value. Every value is invented.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decideSignatureRetry,
  MAX_SIGNATURE_RETRY_ATTEMPTS,
  MAX_SIGNATURE_RETRY_DELAY_MS,
  signatureRetryDelayMs,
} from "./signature-retry.ts";

const policy = fc
  .record({
    maxAttempts: fc.integer({ min: 1, max: MAX_SIGNATURE_RETRY_ATTEMPTS }),
    maxDelayMs: fc.integer({ min: 1, max: MAX_SIGNATURE_RETRY_DELAY_MS }),
    base: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ maxAttempts, maxDelayMs, base }) => ({
    maxAttempts,
    maxDelayMs,
    baseDelayMs: Math.max(1, Math.floor(base * maxDelayMs)),
  }));
const attempt = fc.oneof(fc.integer({ min: -2, max: 12 }), fc.double(), fc.constant(Number.NaN));
const random = fc.oneof(fc.double({ min: 0, max: 1, maxExcluded: true }), fc.double());

describe("signature retry bounds", () => {
  it("every delay is an integer in [1, maxDelayMs]", () => {
    fc.assert(
      fc.property(policy, attempt, random, (p, a, r) => {
        const ms = signatureRetryDelayMs(a, p, r);
        expect(Number.isSafeInteger(ms) && ms >= 1 && ms <= p.maxDelayMs).toBe(true);
      }),
    );
  });

  it("a transient reply on attempt maxAttempts or later is never retried", () => {
    fc.assert(
      fc.property(
        policy,
        fc.integer({ min: 0, max: 20 }),
        fc.constantFrom("keys", "object", "signing", "verification", "store", undefined),
        random,
        (p, extra, stage, r) => {
          const reply = { status: "unavailable", stage, reason: "x" };
          const decision = decideSignatureRetry(reply, p.maxAttempts + extra, p, r);
          expect(decision).toEqual({ action: "park", reason: "exhausted" });
        },
      ),
    );
  });
});
