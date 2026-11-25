import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17): the teacher's mark of a level per criterion of the
// assignment's rubric (SRV-V17-RUBRIC-DEF), on one work, like a private note (D-130). A level is
// 0, 1 or 2, the position of the level in the criterion from the lowest to the highest, or null;
// there is no number of points, sum, weight, grade or rank in a mark and none is ever computed
// from it. A mark names the rubric version it was made against, and the routes read and write
// the latest version only; while the teacher set no rubric the version is 0 and the criteria are
// the six default ones. Only the teacher of the work who wrote a mark reads it. No student route,
// summary, export or submission carries a mark. Identity, institution and author are never in the
// request: the session decides. Separate from the six private working criteria (SRV-1107).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** A work id (evidence.document.id): 1 to 256 code points, trimmed, no control character. */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});
/** 0 the lowest level of the criterion, 1 the middle, 2 the highest: a position, never points. */
const Level = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Null()]);
/** A short note: 1 to 2000 characters, as a comment body; null when none. */
const Note = Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]);
const CriterionId = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" });

export const WorkRubricMark = closed({
  criterionId: CriterionId,
  level: Level,
  note: Note,
});
export type WorkRubricMark = Static<typeof WorkRubricMark>;

export const WorkRubricMarks = closed({
  /** The rubric version the marks are bound to; 0 while the teacher set no rubric. */
  rubricVersion: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  /** One entry per criterion of that version, in the rubric's order, unmarked ones with nulls. */
  marks: Type.Array(WorkRubricMark, { minItems: 1, maxItems: 12 }),
});
export type WorkRubricMarks = Static<typeof WorkRubricMarks>;

export const teacherWorkRubricGet = defineRoute({
  id: "teacher.work-rubric.get",
  method: "GET",
  path: "/api/v1/teacher/works/{documentId}/rubric",
  inventory: "app/api/teacher/works/[documentId]/rubric/route.ts",
  access: "course_teacher",
  summary:
    "The caller's own marks on a work for the latest rubric version of its assignment: {rubricVersion, marks}, one {criterionId, level, note} per criterion in the rubric's order, level 0, 1, 2 or null and note or null where nothing is set. rubricVersion is 0 and the marks cover the six default criteria while the teacher set no rubric. No number, sum, grade or rank. Only the teacher of the work who wrote the marks reads them; the student of the work, another teacher, a teacher of another course, another institution, an unknown work and a malformed id all read the same 404. The read writes nothing in the access log.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the marks of the latest rubric version",
      body: WorkRubricMarks,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherWorkRubricMarkPut = defineRoute({
  id: "teacher.work-rubric-mark.put",
  method: "PUT",
  path: "/api/v1/teacher/works/{documentId}/rubric/{criterionId}",
  inventory: "app/api/teacher/works/[documentId]/rubric/[criterionId]/route.ts",
  access: "course_teacher",
  summary:
    "Sets the level and the note of one criterion of the latest rubric version, replacing both: exactly {level, note}, at most 8 KiB, sent as application/json. level is 0, 1, 2 or null, note 1 to 2000 characters or null; a null for both clears the mark. Anything else, and any other number, is 422 invalid_input. Answers the saved {criterionId, level, note}. Only the teacher of the work; the student, another teacher, an unknown work and a criterion that is not in the latest rubric version read the same 404. The author comes from the session, never from the body.",
  request: {
    params: closed({ documentId: WorkId, criterionId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({ level: Level, note: Note }),
  },
  responses: [
    {
      status: 200,
      description: "the saved mark",
      body: WorkRubricMark,
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
    error(503, "unavailable"),
  ],
});

export const workRubricRoutes = [teacherWorkRubricGet, teacherWorkRubricMarkPut] as const;
