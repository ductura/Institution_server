import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V17-RUBRIC-DEF (Ductus#2055, val 17): the rubric of an assignment, defined by its teacher
// and read by its students before they submit. A list of 1 to 12 criteria, each with a title and
// three levels written in words from the lowest to the highest; there is no number, weight, sum,
// grade or rank in it, and none is ever computed from it. It is versioned by adding only, so a
// later mark that names a version keeps its meaning (SRV-V17-RUBRIC-LEVEL). It is separate from
// the six private working criteria of a mentor (teacher.working-criteria.*, SRV-1107), which no
// student reads. Identity and institution are never in the request: the session decides.

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const AssignmentId = Type.String({ pattern: UUID });

/** The most criteria of one rubric. */
export const RUBRIC_MAX_CRITERIA = 12;
/** The number of levels of every criterion. */
export const RUBRIC_LEVELS = 3;

export const RubricLevel = closed({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  descriptor: Type.String({ maxLength: 400 }),
});
export type RubricLevel = Static<typeof RubricLevel>;

export const RubricCriterion = closed({
  /** Unique in the rubric; 1 to 32 characters of a-z, 0-9, "_" and "-". */
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  levels: Type.Array(RubricLevel, { minItems: RUBRIC_LEVELS, maxItems: RUBRIC_LEVELS }),
});
export type RubricCriterion = Static<typeof RubricCriterion>;

/** What the teacher reads and what a replacement answers: version 0 and no criteria while none is set. */
export const AssignmentRubricTeacher = closed({
  version: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  criteria: Type.Array(RubricCriterion, { maxItems: RUBRIC_MAX_CRITERIA }),
});
export type AssignmentRubricTeacher = Static<typeof AssignmentRubricTeacher>;

/** What the student reads: version 0 and the six default criteria while the teacher set none. */
export const AssignmentRubricStudent = closed({
  version: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  criteria: Type.Array(RubricCriterion, { minItems: 1, maxItems: RUBRIC_MAX_CRITERIA }),
});
export type AssignmentRubricStudent = Static<typeof AssignmentRubricStudent>;

export const AssignmentRubricInput = closed({
  /** The latest version the teacher saw; 0 when there was none. */
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
  criteria: Type.Array(RubricCriterion, { minItems: 1, maxItems: RUBRIC_MAX_CRITERIA }),
});
export type AssignmentRubricInput = Static<typeof AssignmentRubricInput>;

const params = closed({ assignmentId: AssignmentId });

export const teacherAssignmentRubricGet = defineRoute({
  id: "teacher.assignment-rubric.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/rubric",
  inventory: "app/api/teacher/assignments/[assignmentId]/rubric/route.ts",
  access: "course_teacher",
  summary:
    "The latest rubric of an assignment for a teacher of it: {version, criteria}, a criterion being {id, title, levels}, levels exactly three {label, descriptor} from the lowest to the highest. version 0 and no criteria while none is set (the form starts empty; the six default criteria are only what a student reads). Only a teacher of the assignment reads it: a student, a teacher of another course, another institution, an unknown and a malformed assignment id all read the same 404.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "the latest rubric",
      body: AssignmentRubricTeacher,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherAssignmentRubricPut = defineRoute({
  id: "teacher.assignment-rubric.put",
  method: "PUT",
  path: "/api/v1/teacher/assignments/{assignmentId}/rubric",
  inventory: "app/api/teacher/assignments/[assignmentId]/rubric/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment replaces its rubric with a new version: exactly {expectedVersion, criteria}, at most 32 KiB, sent as application/json. expectedVersion is the latest version the teacher saw (0 when none); another version added in between is 409 conflict. 1 to 12 criteria, each exactly {id, title, levels}: an id of 1 to 32 characters of a-z, 0-9, _ and -, unique in the list; a title of 1 to 120 characters; exactly three levels {label 1 to 80 characters, descriptor up to 400}; anything else, and any number, is 422 invalid_input. A stored version is never changed, so earlier versions stay as they were. The answer is the new {version, criteria}. A student, a teacher of another course, another institution and an unknown assignment are the same 404. The institution and the author come from the session, never from the body.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 32768,
    body: AssignmentRubricInput,
  },
  responses: [
    {
      status: 200,
      description: "the new version",
      body: AssignmentRubricTeacher,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const studentAssignmentRubricGet = defineRoute({
  id: "student.assignment-rubric.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/rubric",
  inventory: "app/api/student/assignments/[assignmentId]/rubric/route.ts",
  access: "student_enrolled",
  summary:
    "The rubric of an assignment the caller is enrolled in, before submitting: {version, criteria}. While the teacher set none the answer is version 0 and the six default criteria of the working criteria (topic, structure, sources, method, language, formatting), each with three levels; only in this version 0 are the titles and level labels message keys (workingCriteria.<id>, assignmentRubric.levelLow, levelMid, levelHigh) for the client to show, a stored rubric carries the teacher's own words. No mark, level chosen, number, sum or grade of any work is in it. A teacher, a student of another course, another institution, an unknown and a malformed assignment id all read the same 404.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "the rubric, or the default criteria",
      body: AssignmentRubricStudent,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const assignmentRubricRoutes = [
  teacherAssignmentRubricGet,
  teacherAssignmentRubricPut,
  studentAssignmentRubricGet,
] as const;
