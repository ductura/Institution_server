import type { Handlers } from "./server.ts";
import { teachesCourse, type State } from "./state.ts";
import { latestWorkTemplate } from "./work-template-routes.ts";

// SRV-V17-TEMPLATE-ASSIGN: the work template frozen on an assignment, on the dev fake server.
// The teacher of the course switches it on (the latest version of the institution's template for
// the assignment's work type is frozen; a version already frozen stays) or off; a student of the
// course reads the frozen version. The real rules are 20261219250000_assignment_template_pin.sql.
type Frozen = NonNullable<ReturnType<typeof latestWorkTemplate>>;

// Keyed by the State object, which the reset (POST /__lazni/ponovno) keeps, so the pins are
// cleared with the templates: a pin whose template is gone would answer a version nobody has.
const pins = new WeakMap<State["milestoneProgress"], Map<string, Frozen>>();
const pinsOf = (state: State): Map<string, Frozen> => {
  let all = pins.get(state.milestoneProgress);
  if (all === undefined) pins.set(state.milestoneProgress, (all = new Map()));
  return all;
};

export const ASSIGNMENT_TEMPLATE_HANDLERS: Handlers = {
  "teacher.assignment-template.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = state.assignments.find((a) => a.id === params.assignmentId.toLowerCase());
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || course === undefined || !teachesCourse(course, account)) {
      return { error: "not_found" };
    }
    const all = pinsOf(state);
    if (!body.useInstitutionTemplate) {
      all.delete(assignment.id);
      return { status: 200, body: { useInstitutionTemplate: false, version: null } };
    }
    const frozen = all.get(assignment.id) ?? latestWorkTemplate(state, assignment.content.workType);
    if (frozen === undefined) return { error: "conflict" };
    all.set(assignment.id, frozen);
    return { status: 200, body: { useInstitutionTemplate: true, version: frozen.version } };
  },
  "student.assignment-template.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const assignment = state.assignments.find((a) => a.id === params.assignmentId.toLowerCase());
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    const frozen = assignment === undefined ? undefined : pinsOf(state).get(assignment.id);
    if (frozen === undefined || !course?.studentIds.includes(account.id)) {
      return { error: "not_found" };
    }
    const { version, titlePage, sections, citationStyle } = frozen;
    return { status: 200, body: { version, titlePage, sections, citationStyle } };
  },
};
