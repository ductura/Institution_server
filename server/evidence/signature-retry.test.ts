// DAN-822-1 and 822-2: the decision after one attempt to sign a pending
// receipt, and the loop that runs the attempts. Ported from Ductus
// src/application/evidence/signature-retry.test.ts at b36c82b with the same
// assertions. The look-alike statuses, the inherited keys, the extra keys and
// a policy changed after the build are new. Every value is invented.
import { describe, expect, it, vi } from "vitest";

import type { PendingReceiptRow } from "../database/index.ts";

import type { SignPendingReceiptOutcome } from "./settle-attach.ts";
import {
  createSignPendingReceiptWithRetry,
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

const ROW: PendingReceiptRow = {
  receiptId: "00000000-0000-4000-8000-0000000000c1",
  receiptPayloadText: '{"receiptId":"00000000-0000-4000-8000-0000000000c1"}',
};
const SIGNED = { status: "signed", signedReceipt: RECEIPT };

type Wait = (ms: number) => Promise<void>;
function loop(replies: unknown[], sleep = vi.fn<Wait>(async () => {}), policy = POLICY) {
  const calls: PendingReceiptRow[] = [];
  const signPendingReceipt = vi.fn(async (row: PendingReceiptRow) => {
    calls.push(row);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply as SignPendingReceiptOutcome;
  });
  const run = createSignPendingReceiptWithRetry({
    signPendingReceipt,
    policy,
    sleep,
    random: () => 0.5,
  });
  return { run, calls, sleep };
}

describe("createSignPendingReceiptWithRetry", () => {
  it.each([
    ["refused", { status: "refused", reason: "not_canonical" }, null],
    ["held", { status: "held", reason: "object_absent" }, null],
    ["signer_rejected", { status: "signer_rejected", reason: "key_scope" }, null],
    ["hash", unavailable("hash"), "hash"],
  ])("parks %s after one attempt and never waits", async (reason, reply, stage) => {
    const { run, calls, sleep } = loop([reply]);
    expect(await run(ROW)).toEqual({ status: "parked", reason, attempts: 1, lastStage: stage });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("parks as exhausted after maxAttempts and maxAttempts - 1 waits", async () => {
    const { run, calls, sleep } = loop([unavailable("store")]);
    expect(await run(ROW)).toEqual({
      status: "parked",
      reason: "exhausted",
      attempts: 4,
      lastStage: "store",
    });
    expect(calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["rejects", async () => Promise.reject(new Error("aborted"))],
    [
      "throws synchronously",
      (): Promise<void> => {
        throw new Error("aborted");
      },
    ],
  ])("parks as interrupted when the wait %s, and signs nothing more", async (_, wait) => {
    const { run, calls } = loop([unavailable("keys")], vi.fn(wait));
    expect(await run(ROW)).toEqual({
      status: "parked",
      reason: "interrupted",
      attempts: 1,
      lastStage: "keys",
    });
    expect(calls).toHaveLength(1);
  });

  it("signs the snapshot of the first attempt, a fresh copy each time, without extra keys", async () => {
    const row = { ...ROW, extra: "x" };
    const sleep = vi.fn(async () => {
      row.receiptId = "00000000-0000-4000-8000-0000000000c2";
      row.receiptPayloadText = "{}";
    });
    const { run, calls } = loop([unavailable("object"), SIGNED], sleep);
    await run(row);
    expect(calls).toEqual([ROW, ROW]);
    expect(calls[0]).not.toBe(calls[1]);
    expect(Object.keys(calls[1] ?? {}).sort()).toEqual(["receiptId", "receiptPayloadText"]);
  });

  it("a parked result carries no receipt id, text or signature", async () => {
    const { run } = loop([
      { status: "unavailable", stage: "store", reason: ROW.receiptPayloadText },
    ]);
    const parked = await run(ROW);
    expect(Object.keys(parked).sort()).toEqual(["attempts", "lastStage", "reason", "status"]);
    expect(JSON.stringify(parked)).not.toContain(ROW.receiptId);
  });

  it("retries a signer failure and a throw with backoff, then answers the signed receipt", async () => {
    const { run, calls, sleep } = loop([unavailable("signing"), new Error("down"), SIGNED]);
    expect(await run(ROW)).toEqual({ status: "done", outcome: SIGNED, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([75, 150]);
  });

  it("waits the whole ceiling when the random source throws", async () => {
    const sleep = vi.fn(async () => {});
    const run = createSignPendingReceiptWithRetry({
      signPendingReceipt: vi
        .fn()
        .mockResolvedValueOnce(unavailable("signing"))
        .mockResolvedValueOnce(SIGNED),
      policy: POLICY,
      sleep,
      random: () => {
        throw new Error("no entropy");
      },
    });
    expect((await run(ROW)).status).toBe("done");
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("keeps the limits of the build when the caller changes its policy afterwards", async () => {
    const policy = { ...POLICY, maxAttempts: 2 };
    const { run, calls } = loop([unavailable("store")], undefined, policy);
    policy.maxAttempts = 10;
    expect((await run(ROW)).attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("requires a signing function, a wait, a random source and a policy", () => {
    const base = {
      signPendingReceipt: async () => unavailable("x") as SignPendingReceiptOutcome,
      policy: POLICY,
      sleep: async () => {},
      random: () => 0,
    };
    for (const missing of ["signPendingReceipt", "sleep", "random"] as const) {
      expect(() =>
        createSignPendingReceiptWithRetry({ ...base, [missing]: undefined } as never),
      ).toThrow(TypeError);
    }
    expect(() =>
      createSignPendingReceiptWithRetry({ ...base, policy: undefined } as never),
    ).toThrow(RangeError);
    expect(() =>
      createSignPendingReceiptWithRetry({ ...base, policy: { ...POLICY, maxAttempts: 0 } }),
    ).toThrow(RangeError);
  });
});
