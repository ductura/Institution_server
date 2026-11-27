// Dizajn 1.1: the bound confirmation code of one submission, read under the
// caller's session as student.receipt-pdf.get reads it, and only while that
// submission is the live one of its assignment; anything else refuses with a
// closed reason, never a code of another submission. Every value is invented
// (test-support/portable-record).
import { describe, expect, it } from "vitest";

import { PAYLOAD, sourceOf, SUBMISSION_ID } from "../../test-support/portable-record/index.ts";
import type { MySubmissionStateReader } from "../database/index.ts";

import { createSubmissionConfirmationCode } from "./submission-confirmation-code.ts";

const TOKEN = "a".repeat(43);
const CODE = "DK7M-4Q9P-X2HT-R8VN";
const OTHER = "00000000-0000-4000-8000-000000000009";
const ASSIGNMENT = PAYLOAD.assignmentId;

type Code = Awaited<ReturnType<Parameters<typeof createSubmissionConfirmationCode>[0]["read"]>>;
type State = Awaited<ReturnType<MySubmissionStateReader["state"]>>;

const failed = (code: string) => ({ ok: false, error: { code, messageKey: "x.y" } }) as never;

async function bound(submissionId = SUBMISSION_ID): Promise<State> {
  const source = await sourceOf({ ...PAYLOAD, submissionId });
  return {
    ok: true,
    value: {
      state: "potvrdeno",
      revision: PAYLOAD.revision,
      receiptPayload: source.receiptPayload,
      payloadDigestSha256: source.payloadDigestSha256,
      signature: source.signature,
    },
  } as State;
}

function codeOf(code: Code, state: State) {
  const calls: unknown[][] = [];
  const read = createSubmissionConfirmationCode(
    { read: async (...args) => (calls.push(["code", ...args]), code) },
    {
      state: async (...args) => (calls.push(["state", ...args]), state),
    } as MySubmissionStateReader,
  );
  return { read, calls };
}

describe("createSubmissionConfirmationCode", () => {
  it("gives the bound code of the live submission, both reads under the caller's session", async () => {
    const { read, calls } = codeOf({ ok: true, value: CODE }, await bound());
    expect(await read(TOKEN, ASSIGNMENT, SUBMISSION_ID)).toEqual({ ok: true, code: CODE });
    expect(calls).toEqual([
      ["code", TOKEN, ASSIGNMENT],
      ["state", TOKEN, ASSIGNMENT],
    ]);
  });

  it("refuses when the code cannot be read, before reading the state", async () => {
    const { read, calls } = codeOf(failed("MY_SUBMISSION_STATE_DATABASE_ERROR"), await bound());
    expect(await read(TOKEN, ASSIGNMENT, SUBMISSION_ID)).toEqual({
      ok: false,
      reason: "code_unreadable",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses when the state cannot be read or its receipt does not check", async () => {
    const broken = await bound();
    if (!broken.ok || broken.value.state !== "potvrdeno") throw new Error("unexpected");
    for (const state of [
      failed("MY_SUBMISSION_STATE_NOT_FOUND"),
      { ...broken, value: { ...broken.value, payloadDigestSha256: "0".repeat(64) } },
    ]) {
      const { read } = codeOf({ ok: true, value: CODE }, state);
      expect(await read(TOKEN, ASSIGNMENT, SUBMISSION_ID)).toEqual({
        ok: false,
        reason: "state_unreadable",
      });
    }
  });

  it("never gives the code of another submission: another live one, waiting or none", async () => {
    const states: State[] = [
      await bound(OTHER),
      {
        ok: true,
        value: { state: "ceka", revision: 1, requestedAt: "2026-11-21T10:00:00.000000Z" },
      } as State,
      { ok: true, value: { state: "none" } } as State,
    ];
    for (const state of states) {
      const { read } = codeOf({ ok: true, value: CODE }, state);
      expect(await read(TOKEN, ASSIGNMENT, SUBMISSION_ID)).toEqual({
        ok: false,
        reason: "not_live_submission",
      });
    }
  });

  it("refuses a live submission with no bound code rather than render without it", async () => {
    const { read } = codeOf({ ok: true, value: null }, await bound());
    expect(await read(TOKEN, ASSIGNMENT, SUBMISSION_ID)).toEqual({
      ok: false,
      reason: "code_missing",
    });
  });
});
