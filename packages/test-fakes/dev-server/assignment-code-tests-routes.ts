import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type Assignment, type State } from "./state.ts";

// SRV-V21-KOD-TESTOVI-RUTA: the code tests of an assignment on the dev fake server. A teacher of
// the assignment's course adds a revision (only ever added); a teacher and a student of the course
// read the latest on either path, revision 0 and no tests while none is set. A student who writes
// is 403; anyone else, an unknown and a foreign assignment are the same 404. A repeated test id is
// 422 invalid_code_tests. The real rules are 20261219400000_assignment_code_tests.sql.
type CodeTest = { id: string; title: string; input: unknown; expected: unknown };
type Revision = { revisionNo: number; language: "javascript"; tests: CodeTest[] };

// Keyed by the assignments array, which a reset of the state replaces (the State object itself is kept).
const revisions = new WeakMap<object, Map<string, Revision>>();

type Part = "teacher" | "student" | null;

function partIn(state: State, account: Account, id: string): [Assignment | null, Part] {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  if (assignment === undefined || course === undefined) return [null, null];
  if (teachesCourse(course, account)) return [assignment, "teacher"];
  if (course.studentIds.includes(account.id)) return [assignment, "student"];
  return [null, null];
}

/** The latest revision for a teacher or a student of the assignment, or why there is none to read. */
function latest(
  state: State,
  account: Account | null,
  id: string,
): Revision | "unauthorized" | "not_found" {
  if (account === null) return "unauthorized";
  const [assignment] = partIn(state, account, id);
  if (assignment === null) return "not_found";
  return (
    revisions.get(state.assignments)?.get(assignment.id) ?? {
      revisionNo: 0,
      language: "javascript",
      tests: [],
    }
  );
}

export const ASSIGNMENT_CODE_TESTS_HANDLERS: Handlers = {
  "teacher.assignment-code-tests.get": ({ state, account, params }) => {
    const found = latest(state, account, params.assignmentId);
    return typeof found === "string" ? { error: found } : { status: 200, body: found };
  },
  "teacher.assignment-code-tests.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const [assignment, part] = partIn(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    if (part !== "teacher") return { error: "forbidden" };
    const ids = new Set(body.tests.map((test) => test.id));
    if (ids.size !== body.tests.length) return { error: "invalid_code_tests" };
    const all = revisions.get(state.assignments) ?? new Map<string, Revision>();
    const made: Revision = {
      revisionNo: (all.get(assignment.id)?.revisionNo ?? 0) + 1,
      language: body.language,
      tests: body.tests,
    };
    all.set(assignment.id, made);
    revisions.set(state.assignments, all);
    return { status: 200, body: made };
  },
  "student.assignment-code-tests.get": ({ state, account, params }) => {
    const found = latest(state, account, params.assignmentId);
    return typeof found === "string" ? { error: found } : { status: 200, body: found };
  },
};
