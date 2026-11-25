// SRV-NF1-PREDANO (Ductus#2055 c.7145546227, NF-1 P-6): the logic of
// student.assignment-submissions.get, when each own submission was confirmed,
// over the port server/database/my-assignment-submissions.ts. The HTTP side is
// server/http/student-submission.ts, since this area imports neither http nor
// contracts (docs/server-map.md §2). A potvrdeno row is bound exactly as
// student.submission.get binds it (boundReceipt): the payload must be its own
// JCS, hash to the stored digest and name this assignment and revision. Only
// then do submittedAt and afterDeadline come from it, so the list never says
// more than the receipt the student can read. none and ceka are null; a
// withdrawn submission is none in app.submission_state_of. One receipt that
// does not bind makes the whole answer 503, never a partial list.
import type { MyAssignmentSubmissionsReader } from "../database/index.ts";

import { boundReceipt } from "./student-submission-route.ts";

export type AssignmentSubmission =
  | { assignmentId: string; submittedAt: string; afterDeadline: boolean }
  | { assignmentId: string; submittedAt: null; afterDeadline: null };

export type StudentAssignmentSubmissionsAnswer =
  { status: 200; body: { assignments: AssignmentSubmission[] } } | { status: 401 | 503 };

// The code of MY_SUBMISSION_STATE_UNAUTHENTICATED (server/database/my-submission-state.ts),
// compared by value: this area imports database only as types.
const UNAUTHENTICATED = "MY_SUBMISSION_STATE_UNAUTHENTICATED";

/** The confirmation of each own submission, for the session behind `token`. */
export async function readStudentAssignmentSubmissions(
  reader: MyAssignmentSubmissionsReader,
  token: string,
): Promise<StudentAssignmentSubmissionsAnswer> {
  const read = await reader.read(token);
  if (!read.ok) return { status: read.error.code === UNAUTHENTICATED ? 401 : 503 };
  const assignments: AssignmentSubmission[] = [];
  for (const { assignmentId, stored } of read.value) {
    if (stored.state !== "potvrdeno") {
      assignments.push({ assignmentId, submittedAt: null, afterDeadline: null });
      continue;
    }
    const receipt = await boundReceipt(
      stored.receiptPayload,
      stored.payloadDigestSha256,
      stored.signature,
      { assignmentId, revision: stored.revision },
    );
    if (receipt === null) return { status: 503 };
    const { requestedAt, afterDeadline } = receipt.payload;
    assignments.push({ assignmentId, submittedAt: requestedAt, afterDeadline });
  }
  return { status: 200, body: { assignments } };
}
