// SRV-NF1-PREDANO (Ductus#2055 c.7145546227): student.assignment-submissions.get
// over a fake port. submittedAt and afterDeadline come only from a receipt that
// binds (its own JCS, the stored digest, this assignment and revision); none
// and ceka are null; one receipt that does not bind is 503, never a partial list.
// The receipt is the contract vector of student.submission.get (invented, its digest is real).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  MyAssignmentSubmissionsReader,
  StoredAssignmentSubmission,
} from "../database/index.ts";
import { canonicalizeJcs } from "../domain/index.ts";

import { readStudentAssignmentSubmissions } from "./student-assignment-submissions-route.ts";

type Receipt = {
  payload: Record<string, unknown> & {
    assignmentId: string;
    revision: number;
    requestedAt: string;
    afterDeadline: boolean;
  };
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
const TOKEN = "izmisljeni-token-popisa-predaja-00000000001";
const ASSIGNMENT = RECEIPT.payload.assignmentId;
const OTHER = "00000000-0000-4000-8000-0000000000b7";
const LAST = "ffffffff-0000-4000-8000-0000000000f1";

const confirmed = (over: Record<string, unknown> = {}): StoredAssignmentSubmission => ({
  assignmentId: ASSIGNMENT,
  stored: {
    state: "potvrdeno",
    revision: RECEIPT.payload.revision,
    receiptPayload: canonicalizeJcs(RECEIPT.payload),
    payloadDigestSha256: RECEIPT.payloadDigestSha256,
    signature: structuredClone(RECEIPT.signature),
    ...over,
  } as StoredAssignmentSubmission["stored"],
});

function port(answer: Awaited<ReturnType<MyAssignmentSubmissionsReader["read"]>>) {
  const calls: unknown[][] = [];
  const reader: MyAssignmentSubmissionsReader = {
    read: async (...args) => (calls.push(args), answer),
  };
  return { reader, calls };
}
const error = (code: string) => ({ ok: false as const, error: { code, messageKey: "x.y" } });
const list = (...value: StoredAssignmentSubmission[]) => port({ ok: true, value }).reader;

describe("student.assignment-submissions.get", () => {
  it("maps the port's refusals: unauthenticated 401, anything else 503", async () => {
    const cases: [string, number][] = [
      ["MY_SUBMISSION_STATE_UNAUTHENTICATED", 401],
      ["MY_SUBMISSION_STATE_ROW_MALFORMED", 503],
      ["MY_SUBMISSION_STATE_DATABASE_ERROR", 503],
      ["NEPOZNATO", 503],
    ];
    for (const [code, status] of cases) {
      expect(await readStudentAssignmentSubmissions(port(error(code)).reader, TOKEN)).toEqual({
        status,
      });
    }
  });

  it("asks the port with the token only", async () => {
    const { reader, calls } = port({ ok: true, value: [] });
    expect(await readStudentAssignmentSubmissions(reader, TOKEN)).toEqual({
      status: 200,
      body: { assignments: [] },
    });
    expect(calls).toEqual([[TOKEN]]);
  });

  it("none and ceka are null, potvrdeno the receipt's instant and deadline, in the port's order", async () => {
    const answer = await readStudentAssignmentSubmissions(
      list({ assignmentId: OTHER, stored: { state: "none" } }, confirmed(), {
        assignmentId: LAST,
        stored: { state: "ceka", revision: 2, requestedAt: "2026-11-20T09:15:42.123456Z" },
      }),
      TOKEN,
    );
    expect(answer).toEqual({
      status: 200,
      body: {
        assignments: [
          { assignmentId: OTHER, submittedAt: null, afterDeadline: null },
          {
            assignmentId: ASSIGNMENT,
            submittedAt: RECEIPT.payload.requestedAt,
            afterDeadline: RECEIPT.payload.afterDeadline,
          },
          { assignmentId: LAST, submittedAt: null, afterDeadline: null },
        ],
      },
    });
  });

  it.each<[string, StoredAssignmentSubmission]>([
    [
      "a payload that is not its own JCS",
      confirmed({ receiptPayload: ` ${canonicalizeJcs(RECEIPT.payload)}` }),
    ],
    ["a digest of another text", confirmed({ payloadDigestSha256: "0".repeat(64) })],
    ["another revision", confirmed({ revision: RECEIPT.payload.revision + 1 })],
    ["the receipt of another assignment", { ...confirmed(), assignmentId: OTHER }],
  ])("%s is 503 for the whole list", async (_, bad) => {
    const answer = await readStudentAssignmentSubmissions(
      list({ assignmentId: LAST, stored: { state: "none" } }, bad),
      TOKEN,
    );
    expect(answer).toEqual({ status: 503 });
  });
});
