import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error, REQUEST_ID_PATTERN } from "../schema/index.ts";

import {
  DeclarationPayload,
  DeclarationPayloadV2,
  DeclarationPayloadV3,
  DeclarationQuestionAnswer,
  DeclarationSha256,
  DeclarationTeacherQuestion,
  MAX_RECORDED_TRANSFERS,
} from "./statement.ts";

// SRV-IZJAVA-PITANJE: the question in force and the answer bound with the
// declaration (null without either). Always sent; optional only so older
// clients keep validating.
const Question = {
  question: Type.Optional(DeclarationTeacherQuestion),
  questionAnswer: Type.Optional(DeclarationQuestionAnswer),
};

export const teacherDeclarationGet = defineRoute({
  id: "teacher.declaration.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration",
  inventory: "app/api/teacher/assignments/[assignmentId]/students/[studentId]/declaration/route.ts",
  access: "course_teacher",
  summary:
    "The declaration a student bound to the live submission of the named assignment, for the course teacher. Without a live submission the state is none. An assignment, student or relationship the teacher has no access to returns 404. Opening a bound declaration is recorded in the access log.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the bound declaration with its hash, or none",
      body: Type.Union([
        closed({
          state: Type.Literal("none"),
          payload: Type.Null(),
          declarationSha256: Type.Null(),
          ...Question,
        }),
        closed({
          state: Type.Literal("bound"),
          payload: DeclarationPayload,
          declarationSha256: DeclarationSha256,
          ...Question,
        }),
      ]),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});
// F4-PRE-R06-SRV: the same read with declaration-v2 payloads.
export const teacherDeclarationV2Get = defineRoute({
  id: "teacher.declaration-second.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration-v2",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/declaration-v2/route.ts",
  access: "course_teacher",
  summary:
    "The declaration as teacher.declaration.get reads it, with the attached conversations and the recorded transfers of declaration-v2 payloads. Opening a bound declaration is recorded in the access log.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the bound declaration with its hash, or none",
      body: Type.Union([
        closed({
          state: Type.Literal("none"),
          payload: Type.Null(),
          declarationSha256: Type.Null(),
          ...Question,
        }),
        closed({
          state: Type.Literal("bound"),
          payload: DeclarationPayloadV2,
          declarationSha256: DeclarationSha256,
          ...Question,
        }),
      ]),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});
// AI-RECORDED-5000: the same read with up to 5000 recorded transfers.
export const teacherDeclarationV3Get = defineRoute({
  ...teacherDeclarationV2Get,
  id: "teacher.declaration-third.get",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration-v3",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/declaration-v3/route.ts",
  summary:
    "The declaration as teacher.declaration-second.get reads it, with up to 5000 recorded transfers; teacher.declaration-second.get answers 503 unavailable for a declaration that records more than 500. Opening a bound declaration is recorded in the access log.",
  responses: [
    {
      status: 200,
      description: "the bound declaration with its hash, or none",
      body: Type.Union([
        closed({
          state: Type.Literal("none"),
          payload: Type.Null(),
          declarationSha256: Type.Null(),
          ...Question,
        }),
        closed({
          state: Type.Literal("bound"),
          payload: DeclarationPayloadV3,
          declarationSha256: DeclarationSha256,
          // SRV-IZJAVA-AI-UNBOUND: beside the payload, outside its hash. Optional
          // only so older clients keep validating.
          ai: Type.Optional(
            closed({
              unbound: Type.Array(
                closed({
                  aiTransferId: Type.String({ pattern: REQUEST_ID_PATTERN }),
                  aiTransferSha256: DeclarationSha256,
                }),
                {
                  maxItems: MAX_RECORDED_TRANSFERS,
                  description:
                    "The student's transfer records of the declared document that no evidence revision up to the declared one binds, ordered by aiTransferId: the complement of payload.ai.recorded. A transfer bound only by a later revision stays here.",
                },
              ),
            }),
          ),
          ...Question,
        }),
      ]),
      headers: ["cache-control"],
    },
  ],
});

// F4-NAS-R04-SRV (D-41, declaration-v1 section 8): the conversations the
// student attached to the bound declaration, read by the course teacher one at
// a time, up to the throughSeq the student confirmed and no further. The ids
// come from ai.attachments of teacher.declaration.get.
const ConversationUuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const ConversationMessage = closed({
  seq: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  role: Type.Union([Type.Literal("student_paragraph"), Type.Literal("provider_response")]),
  content: Type.String({ minLength: 1, maxLength: 40_000 }),
  contentSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  createdAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
});

export const teacherDeclarationConversationGet = defineRoute({
  id: "teacher.declaration-conversation.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration/conversations/{conversationId}",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/declaration/conversations/[conversationId]/route.ts",
  access: "course_teacher",
  summary:
    "One AI assistant conversation the student attached to the declaration bound to the live submission, for the course teacher: the messages by seq from 1 to the throughSeq the student confirmed, with the messagesSha256 the declaration carries. A conversation the bound declaration does not attach (unattached, another student's, another assignment's, unknown or malformed id), an assignment or student the teacher has no access to, and a work without a live submission return the same 404; a mentor is refused alike. Opening it is recorded in the access log. A stored conversation that no longer matches what the student confirmed is 503.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
      conversationId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the attached messages, oldest first",
      body: closed({
        conversationId: ConversationUuid,
        throughSeq: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        messagesSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        messages: Type.Array(ConversationMessage, { minItems: 1 }),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});
