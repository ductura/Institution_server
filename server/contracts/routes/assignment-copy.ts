import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1904 (pilot addition P-D4, owner's decision 21. 11. 2026.): the teacher
// of an assignment copies it into a course they teach. The copy is a new
// assignment at version 1 with the content of the source's current version;
// the source is not changed, and no submission and no row about a student is
// copied. Database: institution.copy_assignment (20261130190400).

/** Lowercase UUID. */
const LowerUuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const AnyCaseUuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

/** The body of a copy: the form's key, the target course, and new dates or none. */
export const AssignmentCopyInput = closed({
  /** A UUID the client makes once per form; a repeat answers the same copy. */
  requestKey: AnyCaseUuid,
  /** The course the copy goes to; the caller must teach it. May be the source's own course. */
  courseId: AnyCaseUuid,
  /** Absent: the source's opening. */
  opensAt: Type.Optional(Instant),
  /** Absent: the source's deadline. */
  dueAt: Type.Optional(Instant),
});

export const teacherAssignmentCopyPost = defineRoute({
  id: "teacher.assignment-copy.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/copy",
  inventory: "app/api/teacher/assignments/[assignmentId]/copy/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment's course copies it into a course they also teach: {requestKey, courseId} and optionally new opensAt and dueAt (Date.toISOString), at most 4 KiB. The copy is a new assignment (version 1) with the content of the source's current version; the source is unchanged, and no submission, work or other row about a student is copied. The same key with the same source content and dates answers the same id; otherwise it is 409. An assignment or target course the caller does not teach, a mentorship assignment, an unknown and a malformed id are the same 404 (C-23). An opening not before the deadline, or an AI rule wider than the target course allows, is 422. Success follows the database commit.",
  request: {
    params: closed({ assignmentId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: AssignmentCopyInput,
  },
  responses: [
    {
      status: 201,
      description: "the copy",
      body: closed({ id: LowerUuid, versionNo: Type.Literal(1) }),
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
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const assignmentCopyRoutes = [teacherAssignmentCopyPost] as const;
