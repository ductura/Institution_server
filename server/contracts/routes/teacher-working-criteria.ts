import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1107 (Ductus#2051, wave 11, B-9): the six criteria of the mentor's
// rubric (E§3.5 mentor3 "Kriteriji ocjene") as the teacher's private working
// note on a work, like a private note (D-130). Only the teacher of the work
// who wrote it reads it. No student route, summary, export or submission
// carries a criterion, an assessment or a note, and no number or grade is ever
// computed from it. Identity, institution and author are never in the request:
// the session decides. The criteria are those of the prototype (S.rubric); the label is their message key.

export const WORKING_CRITERION_IDS = [
  "topic",
  "structure",
  "sources",
  "method",
  "language",
  "formatting",
] as const;

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** A work id (evidence.document.id): 1 to 256 code points, trimmed, no control character. */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});
const CriterionId = literals(WORKING_CRITERION_IDS);
/** 0 "treba doraditi", 1 "dobro", 2 "vrlo dobro": a label, never points. */
const Assessment = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Null()]);
/** A short note: 1 to 2000 characters, as a comment body; null when none. */
const Note = Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]);

const Criterion = closed({
  id: CriterionId,
  /** The message key of the criterion's text (`workingCriteria.<id>`), never a sentence. */
  label: Type.String({ pattern: "^workingCriteria\\.[a-z]+$" }),
  assessment: Assessment,
  note: Note,
});

export const teacherWorkingCriteriaGet = defineRoute({
  id: "teacher.working-criteria.get",
  method: "GET",
  path: "/api/v1/teacher/works/{documentId}/working-criteria",
  inventory: "app/api/teacher/works/[documentId]/working-criteria/route.ts",
  access: "course_teacher",
  summary:
    "The six criteria of the caller's own working note on a work, always in the same order, with a null assessment and note where nothing is set. Only the teacher of the work who wrote them reads them; the student, another teacher, an unknown work and a malformed id all read the same 404. The read writes nothing in the access log.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the six criteria",
      body: closed({ criteria: Type.Array(Criterion, { minItems: 6, maxItems: 6 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherWorkingCriterionPut = defineRoute({
  id: "teacher.working-criterion.put",
  method: "PUT",
  path: "/api/v1/teacher/works/{documentId}/working-criteria/{criterionId}",
  inventory: "app/api/teacher/works/[documentId]/working-criteria/[criterionId]/route.ts",
  access: "course_teacher",
  summary:
    "Sets the assessment and the note of one criterion, replacing both: a null clears it, and a criterion with neither reads as not set. Answers the saved criterion. Only the teacher of the work; the student, another teacher, an unknown work and an unknown criterion read the same 404.",
  request: {
    params: closed({ documentId: WorkId, criterionId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({ assessment: Assessment, note: Note }),
  },
  responses: [{ status: 200, description: "the saved criterion", body: Criterion }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const teacherWorkingCriteriaRoutes = [
  teacherWorkingCriteriaGet,
  teacherWorkingCriterionPut,
] as const;
