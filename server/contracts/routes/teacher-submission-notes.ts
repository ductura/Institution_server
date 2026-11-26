import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SubmissionNote } from "./student.ts";

// SRV-F4-NAS-R11 (NAS-51, C-4): the read side of student.submission-notes.get
// for the readers of a student's work. The notes stay apart from the
// submission, its receipt and the process summary (PO-17); this route only
// lets the teacher see them next to the summary.
export const teacherSubmissionNotesGet = defineRoute({
  id: "teacher.submission-notes.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission-notes",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/submission-notes/route.ts",
  access: "course_teacher",
  summary:
    "The notes one student kept beside the named assignment, oldest first, then by id, for a teacher of the course, the teacher of the student's seminar group or the mentor. Possibly empty. An assignment, student or relationship the caller has no access to returns 404. Reading notes is not recorded in the access log.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "notes, possibly empty",
      body: closed({ notes: Type.Array(SubmissionNote) }),
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
