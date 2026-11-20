// SRV-22 (Ductus#2028 c.7009405737): student.submission.get over a fake port.
// potvrdeno is the stored receipt, built as the submission builds it, and only
// when the stored text is its own JCS, hashes to the stored digest and names
// this assignment and revision; anything else is 503, never a partial answer.
// The receipt is the contract vector's (invented, its digest is real).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { MySubmissionStateReader, StoredSubmissionState } from "../database/index.ts";
import { canonicalizeJcs } from "../domain/index.ts";

import { readStudentSubmission } from "./student-submission-route.ts";

type Receipt = {
  payload: Record<string, unknown> & { assignmentId: string; revision: number };
  payloadDigestSha256: string;
  signature: Record<string, unknown>;
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/student.submission.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { name: string; response: { body: { receipt?: Receipt } } }[] };
const RECEIPT = vectors.find((v) => v.name === "potvrdeno")!.response.body.receipt!;
const TOKEN = "izmisljeni-token-stanja-predaje-00000000001";
const ASSIGNMENT = RECEIPT.payload.assignmentId;
const REVISION = RECEIPT.payload.revision;
const TEXT = canonicalizeJcs(RECEIPT.payload);

const bound = (over: Partial<Extract<StoredSubmissionState, { state: "potvrdeno" }>> = {}) => ({
  state: "potvrdeno" as const,
  revision: REVISION,
  receiptPayload: TEXT,
  payloadDigestSha256: RECEIPT.payloadDigestSha256,
  signature: structuredClone(RECEIPT.signature),
  ...over,
});

function port(answer: Awaited<ReturnType<MySubmissionStateReader["state"]>>) {
  const calls: unknown[][] = [];
  const reader: MySubmissionStateReader = {
    state: async (...args) => (calls.push(args), answer),
    requirements: () => Promise.reject(new Error("not this read")),
  };
  return { reader, calls };
}
const error = (code: string) => ({ ok: false as const, error: { code, messageKey: "x.y" } });

describe("student.submission.get", () => {
  it("maps the port's refusals: unauthenticated 401, not_found 404, anything else 503", async () => {
    const cases: [string, number][] = [
      ["MY_SUBMISSION_STATE_UNAUTHENTICATED", 401],
      ["MY_SUBMISSION_STATE_NOT_FOUND", 404],
      ["MY_SUBMISSION_STATE_ROW_MALFORMED", 503],
      ["MY_SUBMISSION_STATE_DATABASE_ERROR", 503],
      ["NEPOZNATO", 503],
    ];
    for (const [code, status] of cases) {
      expect(await readStudentSubmission(port(error(code)).reader, TOKEN, ASSIGNMENT)).toEqual({
        status,
      });
    }
  });

  it("asks the port with the token and the assignment id", async () => {
    const { reader, calls } = port({ ok: true, value: { state: "none" } });
    expect(await readStudentSubmission(reader, TOKEN, ASSIGNMENT)).toEqual({
      status: 200,
      body: { state: "none" },
    });
    expect(calls).toEqual([[TOKEN, ASSIGNMENT]]);
  });

  it("ceka carries only the revision and the request instant", async () => {
    const value = {
      state: "ceka" as const,
      revision: 7,
      requestedAt: "2026-12-20T21:14:05.123456Z",
    };
    expect(
      await readStudentSubmission(port({ ok: true, value }).reader, TOKEN, ASSIGNMENT),
    ).toEqual({ status: 200, body: value });
  });

  it("potvrdeno is the stored receipt; its payload serialises to the stored bytes", async () => {
    const answer = await readStudentSubmission(
      port({ ok: true, value: bound() }).reader,
      TOKEN,
      ASSIGNMENT,
    );
    expect(answer).toEqual({ status: 200, body: { state: "potvrdeno", receipt: RECEIPT } });
    const { payloadDigestSha256: digest, signature } = RECEIPT;
    expect(JSON.stringify(answer.status === 200 && answer.body)).toBe(
      `{"state":"potvrdeno","receipt":{"payload":${TEXT},"payloadDigestSha256":"${digest}","signature":${JSON.stringify(signature)}}}`,
    );
  });

  it.each([
    ["text that is not JSON", { receiptPayload: "{" }],
    ["text that is not its own JCS", { receiptPayload: JSON.stringify(RECEIPT.payload, null, 1) }],
    ["a digest of other bytes", { payloadDigestSha256: "0".repeat(64) }],
    ["another revision", { revision: REVISION + 1 }],
    ["a signature outside the envelope", { signature: { algorithm: "Ed25519" } }],
    [
      "a payload of another schema",
      { receiptPayload: canonicalizeJcs({ ...RECEIPT.payload, receiptSchema: "druga" }) },
    ],
  ])("%s is 503", async (_name, over) => {
    expect(
      await readStudentSubmission(port({ ok: true, value: bound(over) }).reader, TOKEN, ASSIGNMENT),
    ).toEqual({ status: 503 });
  });

  it("a receipt of another assignment is 503", async () => {
    const other = "00000000-0000-4000-8000-0000000000b2";
    expect(
      await readStudentSubmission(port({ ok: true, value: bound() }).reader, TOKEN, other),
    ).toEqual({ status: 503 });
  });
});
