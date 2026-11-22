import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";

// SRV-2003 (Ductus#2052; Ductus#2028 c.7024185874, wweb34 item 3): the teacher's
// read of one work by its document id, for the header of the page of the work
// (N-07, WEB-35) and its previous and next work. Who asks comes only from the
// session; the database decides which works the caller may read (a teacher or
// collaborator of the course, a seminar group teacher for the own group, a
// mentor). The read has no text of the work, no hash and no submission id, and
// it writes nothing to the access log. The shape is that of
// src/app/nastavnik/rad/[id]/predaja/teacher-receipt.ts of the web client.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Name = Type.String({ minLength: 1, maxLength: 256 });

/** The state of the submission, from the same rows as the overview of the assignment. */
export const TEACHER_WORK_STATES = ["predano", "nije_predano", "nakon_roka", "ceka"] as const;

export const teacherWorkGet = defineRoute({
  id: "teacher.work.get",
  method: "GET",
  path: "/api/v1/teacher/works/{documentId}",
  inventory: "app/api/teacher/works/[documentId]/route.ts",
  access: "course_teacher",
  summary:
    "One work by its document id: the student's id and display name (null when the account has no name), the assignment, the state of the submission and the previous and next work of the same assignment among the works the caller may read, in the order of the assignment overview (null at either end). Only a reader of the work; the student, another teacher, an unknown work and a malformed id all read the same 404. The read has no text of the work and writes nothing in the access log.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the work",
      body: closed({
        documentId: WorkId,
        studentId: Uuid,
        studentName: Type.Union([Name, Type.Null()]),
        assignmentId: Uuid,
        state: Type.Union(TEACHER_WORK_STATES.map((state) => Type.Literal(state))),
        prevDocumentId: Type.Union([WorkId, Type.Null()]),
        nextDocumentId: Type.Union([WorkId, Type.Null()]),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherWorkRoutes = [teacherWorkGet] as const;
