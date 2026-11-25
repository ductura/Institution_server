// SRV-NF4-KASNA-POLJE: whether a submission after the deadline is allowed, in
// the dev fake server. Allowed by default; the teacher of the assignment sets
// it, a student of its course reads it, anyone else reads 404.
import type { Handlers } from "./server.ts";
import { type Account, teachesCourse, type State } from "./state.ts";
import { studentAssignments } from "./student-routes.ts";

const FORBIDDEN = new WeakMap<State, Set<string>>();

function forbiddenOf(state: State): Set<string> {
  let set = FORBIDDEN.get(state);
  if (set === undefined) {
    set = new Set();
    FORBIDDEN.set(state, set);
  }
  return set;
}

function taught(state: State, account: Account | null, id: string) {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment
    : null;
}

export const LATE_SUBMISSION_HANDLERS: Handlers = {
  "institution.assignment-late-submission.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    if (body.lateSubmissionAllowed) forbiddenOf(state).delete(assignment.id);
    else forbiddenOf(state).add(assignment.id);
    return { status: 200, body: { lateSubmissionAllowed: body.lateSubmissionAllowed } };
  },
  "student.assignment-late-submission.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = studentAssignments(state, account).find(
      (a) => a.id === params.assignmentId.toLowerCase(),
    );
    if (assignment === undefined) return { error: "not_found" };
    return {
      status: 200,
      body: { lateSubmissionAllowed: !forbiddenOf(state).has(assignment.id) },
    };
  },
};
