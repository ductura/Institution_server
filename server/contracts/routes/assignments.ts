import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

export const assignmentGradeGet = defineRoute({
  id: "teacher.assignment-grade.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/grade",
  inventory: "app/api/teacher/assignments/[assignmentId]/grade/route.ts",
  access: "course_teacher",
  summary:
    "Checks whether the assignment is eligible for grading. Practice assignments return 409. Only a teacher of the assignment can read the result.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    { status: 200, description: "eligible", body: closed({ eligible: Type.Literal(true) }) },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(409, "practice_assignment"),
    error(503, "unavailable"),
  ],
});
