// Dizajn 1.1: the confirmation code of one submission of the caller, for the
// receipt PDF of the portable record and of the submission package, so their
// PDF is the same bytes as student.receipt-pdf.get gives. Both reads are the
// ones that route uses, under the same session: the code through
// app.my_submission_confirmation_code, then the state through
// app.my_submission_state. The code is of the live submission of the
// assignment; it is this submission's only when the state, read after it,
// still shows this submission's bound receipt (withdrawal is final and a
// receipt exists before its code is read). Anything else is a closed refusal,
// never a PDF quietly without the code: a withdrawn submission, or a student
// no longer in the course, has no reader of its code under the session.
import type { ServerResponse } from "node:http";

import {
  createMySubmissionConfirmationCodeReader,
  createMySubmissionStateReader,
  type MySubmissionConfirmationCodeReader,
  type MySubmissionStateReader,
  type WithActor,
} from "../database/index.ts";
import { readStudentSubmission } from "../institution/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";

export type SubmissionConfirmationCodeRefusal =
  "code_unreadable" | "state_unreadable" | "not_live_submission" | "code_missing";

export type SubmissionConfirmationCode = (
  token: string,
  assignmentId: string,
  submissionId: string,
) => Promise<
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: SubmissionConfirmationCodeRefusal }
>;

export function createSubmissionConfirmationCode(
  codes: Pick<MySubmissionConfirmationCodeReader, "read">,
  states: MySubmissionStateReader,
): SubmissionConfirmationCode {
  return async (token, assignmentId, submissionId) => {
    const code = await codes.read(token, assignmentId);
    if (!code.ok) return { ok: false, reason: "code_unreadable" };
    const state = await readStudentSubmission(states, token, assignmentId);
    if (state.status !== 200) return { ok: false, reason: "state_unreadable" };
    if (
      state.body.state !== "potvrdeno" ||
      state.body.receipt.payload.submissionId !== submissionId
    ) {
      return { ok: false, reason: "not_live_submission" };
    }
    // A bound receipt has its code from the same insert; null here is not that.
    if (code.value === null) return { ok: false, reason: "code_missing" };
    return { ok: true, code: code.value };
  };
}

/**
 * The code for the PDF of a record the portable-record reader found, or null
 * after the 503 is sent: a failed read is reported, as in receipt-pdf.ts.
 */
export async function codeForRecord(
  code: SubmissionConfirmationCode,
  token: string,
  submissionId: string,
  receiptPayload: string,
  response: ServerResponse,
  routeId: string,
): Promise<string | null> {
  // The reader checked the payload as a v2 receipt of this very submission.
  const { assignmentId } = JSON.parse(receiptPayload) as { assignmentId: unknown };
  const read =
    typeof assignmentId === "string"
      ? await code(token, assignmentId, submissionId)
      : ({ ok: false, reason: "code_unreadable" } as const);
  if (read.ok) return read.code;
  reportServerError("route", new Error(read.reason), requestIdOf(response), routeId);
  sendProblem(response, 503, "unavailable");
  return null;
}

/** Over main's application withActor, as student.receipt-pdf.get reads both. */
export function createSubmissionConfirmationCodeFor(withActor: WithActor) {
  return createSubmissionConfirmationCode(
    createMySubmissionConfirmationCodeReader(withActor),
    createMySubmissionStateReader(withActor),
  );
}
