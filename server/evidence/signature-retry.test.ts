// DAN-822-1: the decision after one attempt to sign a pending receipt. Ported
// from Ductus src/application/evidence/signature-retry.test.ts at b36c82b with
// the same assertions for the decision and the delay; the loop's cases come
// with the loop (822-2). The look-alike statuses, the inherited keys and the
// extra key are new. Every value is invented.
import { describe, expect, it } from "vitest";

import {
  decideSignatureRetry,
  MAX_SIGNATURE_RETRY_ATTEMPTS,
  MAX_SIGNATURE_RETRY_DELAY_MS,
  signatureRetryDelayMs,
  type SignatureRetryPolicy,
} from "./signature-retry.ts";

const RECEIPT = { payload: { receiptId: "00000000-0000-4000-8000-0000000000c1" }, signature: {} };
const POLICY: SignatureRetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 };
const unavailable = (stage?: string) => ({ status: "unavailable", stage, reason: "x" });

type Expected = "done" | "retry" | "refused" | "held" | "signer_rejected" | "hash";
class Reply {
  status = "signed";
  signedReceipt = RECEIPT;
}
const REFUSALS = [
  "receipt_malformed",
  "not_canonical",
  "unsupported_schema",
  "receipt_id_mismatch",
  "invalid",
  "not_found",
  "digest_mismatch",
];
const HOLDS = ["not_pending", "locator_mismatch", "object_absent", "object_mismatch"];
const LOOK_ALIKES = ["signed ", "signed\r\n", "signed\t", "signed ", "signed\u007F", "SIGNED"];

// Negative classes first, the two done replies last.
const classes: [string, unknown, Expected][] = [
  ...REFUSALS.map((r): [string, unknown, Expected] => [
    `refused ${r}`,
    { status: "refused", reason: r },
    "refused",
  ]),
  ["refused with an extra key", { status: "refused", reason: "invalid", extra: 1 }, "refused"],
  ...HOLDS.map((r): [string, unknown, Expected] => [
    `held ${r}`,
    { status: "held", reason: r },
    "held",
  ]),
  ["signer_rejected", { status: "signer_rejected", reason: "key_revoked" }, "signer_rejected"],
  ["unavailable hash", unavailable("hash"), "hash"],
  ...["keys", "object", "signing", "verification", "store", "elsewhere", undefined].map(
    (stage): [string, unknown, Expected] => [`unavailable ${stage}`, unavailable(stage), "retry"],
  ),
  ["undefined", undefined, "retry"],
  ["null", null, "retry"],
  ["a string", "signed", "retry"],
  ["an array", [{ status: "signed", signedReceipt: RECEIPT }], "retry"],
  ["inherited keys", Object.create({ status: "signed", signedReceipt: RECEIPT }), "retry"],
  ["a class instance", new Reply(), "retry"],
  [
    "own __proto__ key",
    JSON.parse('{"__proto__":{"status":"signed","signedReceipt":{}}}'),
    "retry",
  ],
  ["unknown status", { status: "accepted", signedReceipt: RECEIPT }, "retry"],
  ...LOOK_ALIKES.map((s): [string, unknown, Expected] => [
    `status ${JSON.stringify(s)}`,
    { status: s, signedReceipt: RECEIPT },
    "retry",
  ]),
  ["signed without a receipt", { status: "signed" }, "retry"],
  [
    "already_signed with a string receipt",
    { status: "already_signed", signedReceipt: "sig" },
    "retry",
  ],
  [
    "signed with an inherited receipt",
    { status: "signed", signedReceipt: Object.create(RECEIPT) },
    "retry",
  ],
  ["signed", { status: "signed", signedReceipt: RECEIPT }, "done"],
  ["signed with an extra key", { status: "signed", signedReceipt: RECEIPT, extra: 1 }, "done"],
  ["already_signed", { status: "already_signed", signedReceipt: RECEIPT }, "done"],
];

describe("decideSignatureRetry", () => {
  it.each(classes)("%s", (_, reply, expected) => {
    const first = decideSignatureRetry(reply, 1, POLICY, 0.5);
    if (expected === "done") expect(first).toEqual({ action: "done" });
    else if (expected === "retry") expect(first).toMatchObject({ action: "retry" });
    else expect(first).toEqual({ action: "park", reason: expected });
    // On the last attempt a transient reply is exhausted, never retried.
    const last = decideSignatureRetry(reply, POLICY.maxAttempts, POLICY, 0.5);
    expect(last).toEqual(expected === "retry" ? { action: "park", reason: "exhausted" } : first);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, "1", null, 4, 5])(
    "parks a transient reply on attempt %s as exhausted",
    (attempt) => {
      for (const reply of [unavailable("signing"), undefined]) {
        expect(decideSignatureRetry(reply, attempt as number, POLICY, 0.5)).toEqual({
          action: "park",
          reason: "exhausted",
        });
      }
      const signed = { status: "signed", signedReceipt: RECEIPT };
      expect(decideSignatureRetry(signed, attempt as number, POLICY, 0.5)).toEqual({
        action: "done",
      });
      expect(decideSignatureRetry(unavailable("hash"), attempt as number, POLICY, 0.5)).toEqual({
        action: "park",
        reason: "hash",
      });
    },
  );

  const invalid: [string, unknown][] = [
    ["not an object", 4],
    ["null", null],
    ["an array", [4, 100, 1_000]],
    ["inherited fields", Object.create(POLICY)],
    ["maxAttempts 0", { ...POLICY, maxAttempts: 0 }],
    ["maxAttempts above the cap", { ...POLICY, maxAttempts: MAX_SIGNATURE_RETRY_ATTEMPTS + 1 }],
    ["maxAttempts 1.5", { ...POLICY, maxAttempts: 1.5 }],
    ["baseDelayMs 0", { ...POLICY, baseDelayMs: 0 }],
    ["baseDelayMs above maxDelayMs", { ...POLICY, baseDelayMs: 2_000 }],
    ["maxDelayMs above the cap", { ...POLICY, maxDelayMs: MAX_SIGNATURE_RETRY_DELAY_MS + 1 }],
    ["maxDelayMs as a string", { ...POLICY, maxDelayMs: "1000" }],
  ];
  it.each(invalid)("refuses a policy with %s", (_, policy) => {
    const p = policy as SignatureRetryPolicy;
    expect(() => decideSignatureRetry(unavailable("signing"), 1, p, 0.5)).toThrow(RangeError);
    expect(() => signatureRetryDelayMs(1, p, 0.5)).toThrow(RangeError);
  });
});

describe("signatureRetryDelayMs", () => {
  it("doubles the ceiling up to the cap and keeps every delay in [ceil(ceiling / 2), ceiling]", () => {
    [100, 200, 400, 800, 1_000, 1_000].forEach((ceiling, i) => {
      expect(signatureRetryDelayMs(i + 1, POLICY, 0)).toBe(ceiling / 2);
      expect(signatureRetryDelayMs(i + 1, POLICY, 0.999_999)).toBe(ceiling);
    });
  });

  it.each([Number.NaN, -1, 1, 2, Infinity, "0.5", undefined])(
    "answers an unusable random value %s with the ceiling",
    (random) => {
      expect(signatureRetryDelayMs(2, POLICY, random as number)).toBe(200);
    },
  );

  it("never answers 0, even with a 1 ms base", () => {
    expect(signatureRetryDelayMs(1, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, 0)).toBe(1);
  });

  it.each([0, -1, 1.5, 11, Number.NaN])("counts attempt %s as step 10", (attempt) => {
    const policy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: MAX_SIGNATURE_RETRY_DELAY_MS };
    expect(signatureRetryDelayMs(attempt, policy, 0.999_999)).toBe(1_024);
    expect(signatureRetryDelayMs(attempt, policy, 0)).toBe(512);
  });
});
