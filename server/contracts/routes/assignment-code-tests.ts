import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V21-KOD-TESTOVI-RUTA (Ductus#2058, val 21): the code tests of an assignment. A teacher of
// the assignment writes up to 10 visible tests for JavaScript; a student of it reads them and runs
// them in their own browser (WEB-V21-KOD-POKRETANJE). The server never runs a student's code, and
// a result never comes back: it is no proof of correctness or origin and is no part of a grade.
// A test is {id, title, input, expected}: the student's code defines solve(input), and the browser
// compares its answer with expected by deep equality. The tests are visible to the student, so
// none is hidden. Revisions are only added (institution.assignment_code_tests); identity and
// institution are never in the request: the session decides.

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const AssignmentId = Type.String({ pattern: UUID });

/** The most tests of one assignment. */
export const CODE_TESTS_MAX = 10;
/** The most bytes of a PUT body; the stored tests are held to the same bound by the database. */
export const CODE_TESTS_MAX_BYTES = 16_384;
/** The languages a test may be written for: a closed list. */
export const CODE_TEST_LANGUAGES = ["javascript"] as const;

export const CodeTest = closed({
  /** Unique among the tests; 1 to 32 characters of a-z, 0-9, "_" and "-". */
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  /** Any JSON value, passed to solve(input). */
  input: Type.Unknown(),
  /** Any JSON value, compared with the answer of solve(input) by deep equality. */
  expected: Type.Unknown(),
});
export type CodeTest = Static<typeof CodeTest>;

/** What both sides read and what a replacement answers: revision 0 and no tests while none is set. */
export const AssignmentCodeTests = closed({
  revisionNo: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  language: Type.Union(CODE_TEST_LANGUAGES.map((language) => Type.Literal(language))),
  tests: Type.Array(CodeTest, { maxItems: CODE_TESTS_MAX }),
});
export type AssignmentCodeTests = Static<typeof AssignmentCodeTests>;

export const AssignmentCodeTestsInput = closed({
  language: Type.Union(CODE_TEST_LANGUAGES.map((language) => Type.Literal(language))),
  /** 0 to 10 tests; an empty list is a revision that removes them all. */
  tests: Type.Array(CodeTest, { maxItems: CODE_TESTS_MAX }),
});
export type AssignmentCodeTestsInput = Static<typeof AssignmentCodeTestsInput>;

const params = closed({ assignmentId: AssignmentId });

const READ_SUMMARY =
  "{revisionNo, language, tests}, a test being {id, title, input, expected} (input and expected any JSON value). revisionNo 0, language javascript and no tests while none is set. A teacher and a student of the assignment read the same latest revision on either path (the tests are visible to the student); a teacher of another course, another institution, a mentored assignment, an unknown and a malformed assignment id all read the same 404.";

export const teacherAssignmentCodeTestsGet = defineRoute({
  id: "teacher.assignment-code-tests.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/code-tests",
  inventory: "app/api/teacher/assignments/[assignmentId]/code-tests/route.ts",
  access: "course_teacher",
  summary: `The latest code tests of an assignment for the form of its teacher: ${READ_SUMMARY}`,
  request: { params },
  responses: [
    {
      status: 200,
      description: "the latest revision",
      body: AssignmentCodeTests,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherAssignmentCodeTestsPut = defineRoute({
  id: "teacher.assignment-code-tests.put",
  method: "PUT",
  path: "/api/v1/teacher/assignments/{assignmentId}/code-tests",
  inventory: "app/api/teacher/assignments/[assignmentId]/code-tests/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment adds the next revision of its code tests: exactly {language, tests}, at most 16 KiB, sent as application/json. language is javascript; tests are 0 to 10, each exactly {id, title, input, expected}: an id of 1 to 32 characters of a-z, 0-9, _ and -, unique in the list; a title of 1 to 120 characters; input and expected any JSON value. More than 10 tests, a repeated id and tests the database finds larger than 16 KiB are 422 invalid_code_tests; any other shape is 422 invalid_input. A stored revision is never changed. The answer is the new {revisionNo, language, tests}. A student of the assignment is 403 forbidden; a teacher of another course, another institution, a mentored and an unknown assignment are the same 404. The institution and the author come from the session, never from the body.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: CODE_TESTS_MAX_BYTES,
    body: AssignmentCodeTestsInput,
  },
  responses: [
    {
      status: 200,
      description: "the new revision",
      body: AssignmentCodeTests,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(422, "invalid_code_tests"),
    error(503, "unavailable"),
  ],
});

export const studentAssignmentCodeTestsGet = defineRoute({
  id: "student.assignment-code-tests.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/code-tests",
  inventory: "app/api/student/assignments/[assignmentId]/code-tests/route.ts",
  access: "student_enrolled",
  summary: `The code tests of an assignment the caller is enrolled in, to run in their own browser: ${READ_SUMMARY} No result of a run is ever sent or stored.`,
  request: { params },
  responses: [
    {
      status: 200,
      description: "the latest revision",
      body: AssignmentCodeTests,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const assignmentCodeTestsRoutes = [
  teacherAssignmentCodeTestsGet,
  teacherAssignmentCodeTestsPut,
  studentAssignmentCodeTestsGet,
] as const;
