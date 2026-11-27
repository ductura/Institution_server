import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// F4-PM2-R08-SRV (M2.9, D-50; DAN-380): the accommodation mark of one work,
// a yes or no and nothing else: no kind, reason or note goes in or out. The
// student of the work reads and sets their own until their submission
// request; the holder of the work (a teacher of the course within the
// earlier-work rule, or the mentor) reads it for the teacher overview. Nobody
// else, an assistant of a seminar group included (SRV-1410). Database:
// institution.work_accommodation and institution.set_work_accommodation
// (20261108130000, 20261126100500); edge: server/http/work-accommodation.ts.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Mark = closed({ marked: Type.Boolean() });

export const studentAccommodationGet = defineRoute({
  id: "student.accommodation.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/accommodation",
  inventory: "app/api/student/assignments/[assignmentId]/accommodation/route.ts",
  access: "student_enrolled",
  summary:
    "Whether the caller marked their own work on the assignment as one with an approved accommodation (D-50): a yes or no, never a reason. The identity comes from the session only. Sec-Fetch-Site, when sent, other than same-origin is 403. An assignment the caller is no student of, an unknown one and a malformed id are the same 404 (C-23).",
  request: { params: closed({ assignmentId: Uuid }) },
  responses: [{ status: 200, description: "the mark", body: Mark, headers: ["cache-control"] }],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const studentAccommodationPut = defineRoute({
  id: "student.accommodation.put",
  method: "PUT",
  path: "/api/v1/student/assignments/{assignmentId}/accommodation",
  inventory: "app/api/student/assignments/[assignmentId]/accommodation/route.ts",
  access: "student_enrolled",
  summary:
    "The caller marks or unmarks their own work on the assignment, exactly {marked}, and gets back the mark in force. Setting the mark in force changes nothing. After the caller's submission request the mark is fixed: 409 conflict and nothing changes. A body that is not exactly this is 422. An assignment the caller is no student of, an unknown one and a malformed id are the same 403 forbidden (C-23).",
  request: {
    params: closed({ assignmentId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 64,
    body: Mark,
  },
  responses: [
    { status: 200, description: "the mark in force", body: Mark, headers: ["cache-control"] },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const teacherStudentAccommodationGet = defineRoute({
  id: "teacher.student-accommodation.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/accommodation",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/accommodation/route.ts",
  access: "course_teacher",
  summary:
    "Whether the student's work on the assignment is marked as one with an approved accommodation (D-50), for the holder of the work: a teacher of the course within the earlier-work rule, or the mentor. A yes or no, never a reason. Sec-Fetch-Site, when sent, other than same-origin is 403. An assistant of a seminar group, another student, any other caller, an unknown or a malformed id all read the same 404 (C-23).",
  request: { params: closed({ assignmentId: Uuid, studentId: Uuid }) },
  responses: [{ status: 200, description: "the mark", body: Mark, headers: ["cache-control"] }],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const workAccommodationRoutes = [
  studentAccommodationGet,
  studentAccommodationPut,
  teacherStudentAccommodationGet,
] as const;
