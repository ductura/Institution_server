// F4-PM2-R08-SRV: the accommodation mark of a work (D-50) in the dev fake
// server, a yes or no. The student of the assignment's course reads and sets
// their own until their work is submitted (409 conflict after); the holder of
// the course reads a student's mark. A group teacher and everyone else get
// 404, a student setting another's assignment 403, as on the real server.
import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

// Keyed by a map that createState makes anew, so the reset (POST /__lazni/ponovno, which keeps the
// State object itself) clears every mark, as work-template-routes.ts does.
type Key = State["milestoneProgress"];
const MARKS = new WeakMap<Key, Set<string>>();

function marksOf(state: State): Set<string> {
  let set = MARKS.get(state.milestoneProgress);
  if (set === undefined) {
    set = new Set();
    MARKS.set(state.milestoneProgress, set);
  }
  return set;
}

const key = (assignmentId: string, studentId: string) => `${assignmentId}/${studentId}`;

function courseOf(state: State, assignmentId: string) {
  const assignment = state.assignments.find((a) => a.id === assignmentId.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined && course !== undefined ? { assignment, course } : null;
}

/** The assignment when `studentId` is a student of its course. */
function studentAssignment(state: State, assignmentId: string, studentId: string | undefined) {
  const found = courseOf(state, assignmentId);
  return found !== null && studentId !== undefined && found.course.studentIds.includes(studentId)
    ? found.assignment
    : null;
}

export const WORK_ACCOMMODATION_HANDLERS: Handlers = {
  "student.accommodation.get": ({ state, account, params }) => {
    const assignment = studentAssignment(state, params.assignmentId, account?.id);
    if (assignment === null || account === null) return { error: "not_found" };
    return { status: 200, body: { marked: marksOf(state).has(key(assignment.id, account.id)) } };
  },
  "student.accommodation.put": ({ state, account, params, body }) => {
    const assignment = studentAssignment(state, params.assignmentId, account?.id);
    if (assignment === null || account === null) return { error: "forbidden" };
    // Any submission locks the mark, also one withdrawn since (app.work_submission_requested).
    const submitted =
      state.works.some(
        (w) =>
          w.assignmentId === assignment.id && w.studentId === account.id && w.submittedAt !== null,
      ) ||
      state.submissionWithdrawals.some(
        (w) => w.assignmentId === assignment.id && w.studentId === account.id,
      );
    if (submitted) return { error: "conflict" };
    const marks = marksOf(state);
    if (body.marked) marks.add(key(assignment.id, account.id));
    else marks.delete(key(assignment.id, account.id));
    return { status: 200, body: { marked: body.marked } };
  },
  "teacher.student-accommodation.get": ({ state, account, params }) => {
    const found = courseOf(state, params.assignmentId);
    const studentId = params.studentId.toLowerCase();
    if (
      found === null ||
      account === null ||
      found.course.holderId !== account.id ||
      !found.course.studentIds.includes(studentId)
    ) {
      return { error: "not_found" };
    }
    return {
      status: 200,
      body: { marked: marksOf(state).has(key(found.assignment.id, studentId)) },
    };
  },
};
