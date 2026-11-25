// SRV-ASIST-PREKIDAC: the assistant switch per course and the availability of
// the assistant, in the dev fake server. On by default; a teacher of the course
// reads and sets it, a student of an assignment reads the availability, anyone
// else reads 404. As in ASSISTANT_HANDLERS (assistant-routes.ts), the dev
// server has no provider, so the availability is always false, the same as the
// request route's ai_disabled.
import type { Handlers } from "./server.ts";
import { type Account, teachesCourse, type State } from "./state.ts";
import { studentAssignments } from "./student-routes.ts";

const OFF = new WeakMap<State, Set<string>>();

function offOf(state: State): Set<string> {
  let set = OFF.get(state);
  if (set === undefined) {
    set = new Set();
    OFF.set(state, set);
  }
  return set;
}

function taught(state: State, account: Account | null, id: string) {
  const course = state.courses.find((c) => c.id === id.toLowerCase());
  return course !== undefined && account !== null && teachesCourse(course, account) ? course : null;
}

export const COURSE_ASSISTANT_HANDLERS: Handlers = {
  "teacher.course-assistant.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = taught(state, account, params.courseId);
    if (course === null) return { error: "not_found" };
    return { status: 200, body: { enabled: !offOf(state).has(course.id) } };
  },
  "teacher.course-assistant.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = taught(state, account, params.courseId);
    if (course === null) return { error: "not_found" };
    if (body.enabled) offOf(state).delete(course.id);
    else offOf(state).add(course.id);
    return { status: 200, body: { enabled: body.enabled } };
  },
  "student.assignment-assistant.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = studentAssignments(state, account).find(
      (a) => a.id === params.assignmentId.toLowerCase(),
    );
    if (assignment === undefined) return { error: "not_found" };
    return { status: 200, body: { assistantEnabled: false } };
  },
  // SRV-ASIST-BROJAC: the dev server has no assistant, so no limit and nothing used.
  "student.assignment-assistant-requests.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = studentAssignments(state, account).find(
      (a) => a.id === params.assignmentId.toLowerCase(),
    );
    if (assignment === undefined) return { error: "not_found" };
    return { status: 200, body: { limit: null, used: 0 } };
  },
};
