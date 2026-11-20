// SRV-30 (Ductus#2028 c.7009405737): the logic of teacher.submission-receipt.get,
// one student's submission state for a reader of that student's work, over
// the port server/database/my-submission-state.ts (SRV-20
// app.teacher_submission_state). The receipt is checked and built exactly as
// for the student (boundReceipt), so the teacher reads the same bytes the
// student reads (PRODUCT §5 rule 5). The read has no work content and writes
// nothing to the access log (P-5, Ductus#2028 c.7010418731). Every refusal, an
// unknown and a malformed id read 404 alike (C-23); a stored row this read
// cannot vouch for is 503, never a partial answer.
import type { MySubmissionStateReader } from "../database/index.ts";

import { boundReceipt, type StudentSubmissionAnswer } from "./student-submission-route.ts";

// The codes of MY_SUBMISSION_STATE_* (server/database/my-submission-state.ts),
// compared by value: this area imports database only as types.
const UNAUTHENTICATED = "MY_SUBMISSION_STATE_UNAUTHENTICATED";
const NOT_FOUND = "MY_SUBMISSION_STATE_NOT_FOUND";

/** The submission state of `studentId` on `assignmentId` for the session behind `token`. */
export async function readTeacherSubmission(
  reader: MySubmissionStateReader,
  token: string,
  assignmentId: string,
  studentId: string,
): Promise<StudentSubmissionAnswer> {
  const read = await reader.teacherState(token, assignmentId, studentId);
  if (!read.ok) {
    if (read.error.code === UNAUTHENTICATED) return { status: 401 };
    if (read.error.code === NOT_FOUND) return { status: 404 };
    return { status: 503 };
  }
  const stored = read.value;
  if (stored.state === "none") return { status: 200, body: { state: "none" } };
  if (stored.state === "ceka") {
    const { revision, requestedAt } = stored;
    return { status: 200, body: { state: "ceka", revision, requestedAt } };
  }
  const receipt = await boundReceipt(
    stored.receiptPayload,
    stored.payloadDigestSha256,
    stored.signature,
    { assignmentId, revision: stored.revision },
  );
  return receipt === null
    ? { status: 503 }
    : { status: 200, body: { state: "potvrdeno", receipt } };
}
