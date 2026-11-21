import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { DeclarationPayload, DeclarationSha256 } from "./statement.ts";

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
        }),
        closed({
          state: Type.Literal("bound"),
          payload: DeclarationPayload,
          declarationSha256: DeclarationSha256,
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
