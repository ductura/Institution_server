import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const versionFields = { studentId: Uuid, revision: Revision, late: Type.Boolean() };

export const TeacherSubmittedVersion = closed({
  ...versionFields,
  submissionId: Type.Union([Uuid, Type.Null()], {
    description: "The recorded submission ID, or null until the receipt is bound.",
  }),
});

export const teacherSubmissionDetailGet = defineRoute({
  id: "teacher.submission-detail.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/submissions/{submissionId}",
  inventory: "app/api/teacher/assignments/[assignmentId]/submissions/[submissionId]/route.ts",
  access: "course_teacher",
  summary:
    "The immutable submitted document identified by a bound submission receipt. The teacher must have access to the work in the named assignment. The opening is recorded in the access log.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      submissionId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the submitted version and the lateness recorded at submission",
      body: closed({
        ...versionFields,
        submissionId: Uuid,
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
