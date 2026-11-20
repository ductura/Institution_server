// SRV-22 (Ductus#2028 c.7009405737): the logic of
// student.assignment-requirements.get, the word range of the current version
// of one assignment for a student of its course (PO-12), over the port
// server/database/my-submission-state.ts (SRV-20
// app.my_assignment_requirements). The HTTP side is
// server/http/student-submission.ts. No bound at either end is a null range;
// another's, an unknown and a malformed assignment read 404 alike (C-23).
import type { MySubmissionStateReader } from "../database/index.ts";

export type StudentWordRange = { min: number | null; max: number | null } | null;

export type StudentRequirementsAnswer =
  { status: 200; body: { wordRange: StudentWordRange } } | { status: 401 | 404 | 503 };

// The codes of MY_SUBMISSION_STATE_*, compared by value (see
// student-submission-route.ts).
const UNAUTHENTICATED = "MY_SUBMISSION_STATE_UNAUTHENTICATED";
const NOT_FOUND = "MY_SUBMISSION_STATE_NOT_FOUND";

/** The word range of `assignmentId` for the session behind `token`. */
export async function readStudentRequirements(
  reader: MySubmissionStateReader,
  token: string,
  assignmentId: string,
): Promise<StudentRequirementsAnswer> {
  const read = await reader.requirements(token, assignmentId);
  if (!read.ok) {
    if (read.error.code === UNAUTHENTICATED) return { status: 401 };
    if (read.error.code === NOT_FOUND) return { status: 404 };
    return { status: 503 };
  }
  const { wordMin: min, wordMax: max } = read.value;
  return {
    status: 200,
    body: { wordRange: min === null && max === null ? null : { min, max } },
  };
}
