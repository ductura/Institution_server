import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

export const teacherSubmissionDetailGet = defineRoute({
  id: "teacher.submission-detail.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/submissions/{studentId}",
  inventory: "app/api/teacher/assignments/[assignmentId]/submissions/[studentId]/route.ts",
  access: "course_teacher",
  summary:
    "The immutable submitted document of a student in the named assignment. The teacher must have access to the work. Missing or inaccessible submissions return 404. Opening the submitted document is recorded in the access log.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the submitted version and the lateness recorded at submission",
      body: closed({
        studentId: Uuid,
        revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        late: Type.Boolean(),
        document: Type.String({
          description: "The exact UTF-8 JSON text of the submitted document.",
        }),
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
