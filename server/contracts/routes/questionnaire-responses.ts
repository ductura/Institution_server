import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V18-UPITNIK-ISPUNJAVANJE (Ductus#2055 / Ductus#2058; val 18, docs/nalazi/
// val18-razlika.md V18-1, V18-2): a student of the course reads the open
// questionnaires of the courses studied in and answers one once; a teacher of
// the course enters a sheet by hand (invented or on paper). The sheet carries
// no person: who took part is kept apart from what was answered, so no route
// here (or anywhere) can read the one from the other. Access comes only from
// the relation (a student enrolled in the course, a teacher of the course),
// never from a role alone (C-23): another's, an unknown, a malformed and, for a
// student, a not open questionnaire all read the same 404. Database:
// app.student_questionnaires, app.student_questionnaire,
// app.submit_questionnaire_response and app.manual_questionnaire_response
// (20261219380000). New routes, no new error codes.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const IdParams = closed({ id: Uuid });

// The limits are those of server/domain/questionnaire (definition.ts, answers.ts).
const Option = closed({
  code: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }),
  label: Type.String({ minLength: 1, maxLength: 120 }),
});
const Question = closed({
  id: Uuid,
  order: Type.Integer({ minimum: 1, maximum: 40 }),
  kind: Type.Union([
    Type.Literal("single"),
    Type.Literal("multiple"),
    Type.Literal("scale"),
    Type.Literal("number"),
    Type.Literal("text"),
  ]),
  text: Type.String({ minLength: 1, maxLength: 500 }),
  options: Type.Union([Type.Array(Option, { minItems: 2, maxItems: 20 }), Type.Null()]),
  scale: Type.Union([
    closed({
      min: Type.Integer({ minimum: 0, maximum: 9 }),
      max: Type.Integer({ minimum: 1, maximum: 10 }),
    }),
    Type.Null(),
  ]),
});
const Form = closed({
  id: Uuid,
  courseId: Uuid,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  participated: Type.Boolean(),
  questions: Type.Array(Question, { minItems: 1, maxItems: 40 }),
});
const ListItem = closed({
  id: Uuid,
  courseId: Uuid,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  participated: Type.Boolean(),
});
const Answer = closed({
  questionId: Uuid,
  value: Type.Union([
    Type.String({ minLength: 1, maxLength: 2000 }),
    // The magnitude (at most 10^9) is checked by the database, which answers 422.
    Type.Number(),
    Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 1, maxItems: 20 }),
  ]),
});
const Answers = closed({ answers: Type.Array(Answer, { minItems: 1, maxItems: 40 }) });

// 40 answers of up to 2000 characters, escaped, with room for the keys.
const MAX_BODY_BYTES = 524_288;
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const WRITE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(409, "conflict"),
  error(503, "unavailable"),
];

export const studentQuestionnairesGet = defineRoute({
  id: "student.questionnaires.get",
  method: "GET",
  path: "/api/v1/student/questionnaires",
  inventory: "app/api/student/questionnaires/route.ts",
  access: "student_enrolled",
  summary:
    "The open questionnaires of the courses the student is enrolled in, as {id, courseId, title, participated}: participated is true when this student already answered. A draft, a closed questionnaire and one of a course the student is not in are not listed.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the open questionnaires",
      body: closed({ questionnaires: Type.Array(ListItem) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const studentQuestionnaireGet = defineRoute({
  id: "student.questionnaire.get",
  method: "GET",
  path: "/api/v1/student/questionnaires/{id}",
  inventory: "app/api/student/questionnaires/[id]/route.ts",
  access: "student_enrolled",
  summary:
    "The form of an open questionnaire of a course the student is enrolled in, questions in the author's order. A draft, a closed, another course's, an unknown or a malformed questionnaire id returns the same 404.",
  request: { params: IdParams },
  responses: [{ status: 200, description: "the form", body: Form }],
  errors: READ_ERRORS,
});

export const studentQuestionnaireResponsesPost = defineRoute({
  id: "student.questionnaire-responses.post",
  method: "POST",
  path: "/api/v1/student/questionnaires/{id}/responses",
  inventory: "app/api/student/questionnaires/[id]/responses/route.ts",
  access: "student_enrolled",
  summary:
    "A student of the course answers an open questionnaire once: exactly {answers[{questionId, value}]}, one answer per question at most, at least one, each of the kind of its question (single: an option code; multiple: distinct option codes; scale: an integer in the scale; number: a finite number; text: a line of text). The sheet is stored without the person; only the fact of taking part is kept. A second answer is 409 conflict and stores nothing. A body that is not exactly this, an answer that does not fit its question and a question that is not of this questionnaire are 422. A draft, a closed, another course's, an unknown or a malformed questionnaire id returns 404.",
  request: {
    params: IdParams,
    contentType: "application/json",
    maxBodyBytes: MAX_BODY_BYTES,
    body: Answers,
  },
  responses: [{ status: 204, description: "the sheet is stored" }],
  errors: WRITE_ERRORS,
});

export const teacherQuestionnaireManualResponsesPost = defineRoute({
  id: "teacher.questionnaire-manual-responses.post",
  method: "POST",
  path: "/api/v1/teacher/questionnaires/{id}/responses/manual",
  inventory: "app/api/teacher/questionnaires/[id]/responses/manual/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the course enters one sheet by hand (invented or on paper), exactly {answers[{questionId, value}]} as a student sends it. The sheet has no person and no participation is recorded, so it does not stop any student from answering. Only while the questionnaire is open: a draft or a closed questionnaire is 409 conflict. An answer that does not fit its question is 422. A student, a teacher of another course, an unknown or a malformed questionnaire id returns 404.",
  request: {
    params: IdParams,
    contentType: "application/json",
    maxBodyBytes: MAX_BODY_BYTES,
    body: Answers,
  },
  responses: [{ status: 204, description: "the sheet is stored" }],
  errors: WRITE_ERRORS,
});

export const questionnaireResponsesRoutes = [
  studentQuestionnairesGet,
  studentQuestionnaireGet,
  studentQuestionnaireResponsesPost,
  teacherQuestionnaireManualResponsesPost,
] as const;
