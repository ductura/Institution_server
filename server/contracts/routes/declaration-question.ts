import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-IZJAVA-PITANJE (owner decision of 23. 11. 2026, NF-5 question 3;
// declaration-v1 section 6.8): the one optional question the teacher of an
// assignment asks with the declaration. Only the teacher of the assignment
// (the course teacher or the mentor of the work, C-23, from the relation)
// reads and sets it; the student reads it as teacherQuestion in
// student.declaration.get and answers it in student.declaration.put. It may
// change after the assignment is published; every change is recorded with its
// author and time and never changed (audit.declaration_question_event).
// Database: institution.declaration_question_setting,
// institution.set_declaration_question (20261214150000).

/** Up to 500 Unicode code points; TypeBox counts UTF-16 units. */
export const DECLARATION_QUESTION_MAX_CODE_POINTS = 500;
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const QuestionText = Type.String({
  minLength: 1,
  maxLength: 2 * DECLARATION_QUESTION_MAX_CODE_POINTS,
  description:
    "Up to 500 Unicode code points, NFC, no leading or trailing space, no control character but the line feed.",
});
const AssignmentParams = closed({ assignmentId: Uuid });

const Setting = closed({
  /** Null: no question (never asked, or removed). */
  question: Type.Union([QuestionText, Type.Null()]),
  /** Null: never changed. */
  changedAt: Type.Union([Instant, Type.Null()]),
});
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/declaration-question/route.ts";
const PATH = "/api/v1/teacher/assignments/{assignmentId}/declaration-question";

export const teacherDeclarationQuestionGet = defineRoute({
  id: "teacher.declaration-question.get",
  method: "GET",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "The optional question the teacher asks with the declaration of the assignment (null: none), and when it was last changed, for the teacher of the assignment. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: { params: AssignmentParams },
  responses: [
    { status: 200, description: "the question", body: Setting, headers: ["cache-control"] },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherDeclarationQuestionPut = defineRoute({
  id: "teacher.declaration-question.put",
  method: "PUT",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "The teacher of the assignment sets the optional question asked with the declaration, exactly {question}: a text of up to 500 code points, or null to remove it. It may change after the assignment is published; every change is recorded with its author and time in the same transaction, and setting the question in force changes nothing. An answer already saved keeps the question it answered. A body that is not exactly this is 422. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: closed({ question: Type.Union([QuestionText, Type.Null()]) }),
  },
  responses: [
    {
      status: 200,
      description: "the question in force",
      body: Setting,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const declarationQuestionRoutes = [
  teacherDeclarationQuestionGet,
  teacherDeclarationQuestionPut,
] as const;
