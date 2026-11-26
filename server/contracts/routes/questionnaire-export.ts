import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-V18-UPITNIK-IZVOZ (Ductus#2058; val 18, docs/nalazi/val18-razlika.md
// V18-1, V18-4, V18-6): the author of a questionnaire reads its answers as
// questionnaire-export-v1, a preparation for the later statistics wave and
// nothing more: no statistics service exists and none is called. A row is one
// sheet with no person and no time; the rows are in the order of a hash of the
// sheet id, never in the order they came in, and the export is the same bytes
// for the same input. Free text stays out unless the author asks for it. Below
// the least number of sheets (QUESTIONNAIRE_EXPORT_MIN_RESPONSES, OP-V18-4) the
// answer is 409, not a thin export that would point at a person. No grade,
// rank, sum or comparison of a person is in it. CSV is built by the web from
// this JSON (V18-6). Access comes only from the relation (a teacher of the
// course), never from a role alone (C-23). Database: app.teacher_questionnaire,
// app.questionnaire_response_ids and app.questionnaire_answer_rows
// (20261219380000). New route, no new error codes.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

// The limits are those of server/domain/questionnaire (definition.ts, answers.ts).
const Option = closed({
  code: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }),
  label: Type.String({ minLength: 1, maxLength: 120 }),
});
const Variable = closed({
  questionId: Uuid,
  order: Type.Integer({ minimum: 1, maximum: 40 }),
  kind: Type.Union([
    Type.Literal("single"),
    Type.Literal("multiple"),
    Type.Literal("scale"),
    Type.Literal("number"),
    Type.Literal("text"),
  ]),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  options: Type.Array(Option, { maxItems: 20 }),
});
const Value = Type.Union([
  Type.String({ minLength: 1, maxLength: 2000 }),
  Type.Number(),
  Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 1, maxItems: 20 }),
  Type.Null(),
]);
const Row = closed({
  n: Type.Integer({ minimum: 1 }),
  values: Type.Record(Uuid, Value),
});

export const teacherQuestionnaireExportGet = defineRoute({
  id: "teacher.questionnaire-export.get",
  method: "GET",
  path: "/api/v1/teacher/questionnaires/{id}/export",
  inventory: "app/api/teacher/questionnaires/[id]/export/route.ts",
  access: "course_teacher",
  summary:
    "The answers of a questionnaire as questionnaire-export-v1, for a teacher of its course: {schema, questionnaireId, variables[{questionId, order, kind, label, options}], rows[{n, values{questionId: value|null}}], responseCount, includesText}. A row is one sheet with no person and no time; n is the position of the sheet in the order of a hash of its id, never of the time it came in, and the same sheets give the same bytes. A question without an answer on a sheet is null. Free-text questions are left out (includesText false) unless the query is includeText=true; any other value of includeText is 422 invalid_input, and any other parameter is 422 too. A read that is not same-origin (Sec-Fetch-Site other than same-origin) is 403 forbidden. Fewer sheets than the least number for an export (5) is 409 conflict and returns nothing. The export has no grade, rank, sum or comparison of a person and is not sent to any service; the web builds CSV from it. A student, a teacher of another course, an unknown and a malformed questionnaire id return the same 404.",
  request: {
    params: closed({ id: Uuid }),
    query: Type.Object({
      includeText: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the export",
      body: closed({
        schema: Type.Literal("questionnaire-export-v1"),
        questionnaireId: Uuid,
        variables: Type.Array(Variable, { maxItems: 40 }),
        rows: Type.Array(Row),
        responseCount: Type.Integer({ minimum: 5 }),
        includesText: Type.Boolean(),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const questionnaireExportRoutes = [teacherQuestionnaireExportGet] as const;
