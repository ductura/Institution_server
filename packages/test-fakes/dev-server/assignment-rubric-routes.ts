import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type Assignment, type State } from "./state.ts";

// SRV-V17-RUBRIC-DEF: the rubric of an assignment on the dev fake server. A teacher of the
// assignment's course reads it and adds a version (only ever added); a student of the course
// reads it, the six default criteria while none is set. Anyone else, an unknown and a foreign
// assignment read the same 404. The real rules are 20261219220000_assignment_rubric.sql.
type Level = { label: string; descriptor: string };
type Criterion = { id: string; title: string; levels: Level[] };
type Rubric = { version: number; criteria: Criterion[] };

// Keyed by the assignments array, which a reset of the state replaces (the State object itself is kept).
const rubrics = new WeakMap<object, Map<string, Rubric>>();

const IDS = ["topic", "structure", "sources", "method", "language", "formatting"];
const defaultCriteria = (): Criterion[] =>
  IDS.map((id) => ({
    id,
    title: `workingCriteria.${id}`,
    levels: ["levelLow", "levelMid", "levelHigh"].map((key) => ({
      label: `assignmentRubric.${key}`,
      descriptor: "",
    })),
  }));

function assignmentOf(
  state: State,
  account: Account,
  id: string,
  as: "teacher" | "student",
): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  if (assignment === undefined || course === undefined) return null;
  const ok =
    as === "teacher" ? teachesCourse(course, account) : course.studentIds.includes(account.id);
  return ok ? assignment : null;
}

const blank = (text: string): boolean => text.trim() === "";

export const ASSIGNMENT_RUBRIC_HANDLERS: Handlers = {
  "teacher.assignment-rubric.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = assignmentOf(state, account, params.assignmentId, "teacher");
    if (assignment === null) return { error: "not_found" };
    return {
      status: 200,
      body: rubrics.get(state.assignments)?.get(assignment.id) ?? { version: 0, criteria: [] },
    };
  },
  "teacher.assignment-rubric.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = assignmentOf(state, account, params.assignmentId, "teacher");
    if (assignment === null) return { error: "not_found" };
    const ids = new Set(body.criteria.map((criterion) => criterion.id));
    if (
      ids.size !== body.criteria.length ||
      body.criteria.some(
        (criterion) =>
          blank(criterion.title) || criterion.levels.some((level) => blank(level.label)),
      )
    ) {
      return { error: "invalid_input" };
    }
    const all = rubrics.get(state.assignments) ?? new Map<string, Rubric>();
    const latest = all.get(assignment.id)?.version ?? 0;
    if (body.expectedVersion !== latest) return { error: "conflict" };
    const made: Rubric = { version: latest + 1, criteria: body.criteria };
    all.set(assignment.id, made);
    rubrics.set(state.assignments, all);
    return { status: 200, body: made };
  },
  "student.assignment-rubric.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = assignmentOf(state, account, params.assignmentId, "student");
    if (assignment === null) return { error: "not_found" };
    return {
      status: 200,
      body: rubrics.get(state.assignments)?.get(assignment.id) ?? {
        version: 0,
        criteria: defaultCriteria(),
      },
    };
  },
};
