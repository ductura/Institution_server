import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { Minute as SummaryMinute, ProcessSummaryV1 } from "./process-summary-shape.ts";

// Literal port of Ductus 078c780: src/server/institution/teacher-courses.ts
// (DAN-230), src/server/evidence/assignment-submissions.ts (DAN-332 R1) and
// src/server/institution/mentored-works.ts (DAN-477). Who asks comes only from
// the session; the database decides which rows. Each read answers for all of
// its rows: a row it cannot vouch for makes the whole answer 503, never a
// partial list. A cross-site read (Sec-Fetch-Site other than same-origin) is
// 403. No handler yet (CONTRACT_ONLY).

/** Lowercase UUID, as the Ductus UUID check of these reads. */
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** A whole UTC minute. */
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
/**
 * A work id (evidence.document.id): 1 to 256 code points, trimmed, no control
 * character. JSON Schema counts UTF-16 units, so the bound here is 512; the
 * server keeps the exact rule (server/contracts/work-id.ts).
 */
const WorkId = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!\\s)[^\\u0000-\\u001f\\u007f-\\u009f]*(?<!\\s)$",
});
const Count = (minimum: number) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const READ_ERRORS = [error(401, "unauthorized"), error(403, "forbidden")] as const;

const TeacherAssignment = closed({
  id: Uuid,
  title: Type.String({ minLength: 1 }),
  workType: literals([
    ...["short_paper", "essay", "seminar_paper", "bachelor_thesis", "master_thesis"],
    ...["specialist_thesis", "doctoral_thesis"],
  ]),
  opensAt: Instant,
  dueAt: Instant,
  currentVersion: Count(1),
  /** The number of students of the course; no student is named. */
  enrolledStudents: Count(0),
});

export const teacherCoursesGet = defineRoute({
  id: "teacher.courses.get",
  method: "GET",
  path: "/api/v1/teacher/courses",
  inventory: "app/api/teacher/courses/route.ts",
  access: "teacher",
  summary:
    "The teacher's courses and their assignments (institution.list_teacher_courses). Courses by academic year descending, then name (hr collation), then id; assignments by due time, then title, then id. Each course carries its rule on AI help, which a new assignment may only keep or narrow.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the courses, possibly none",
      body: closed({
        courses: Type.Array(
          closed({
            id: Uuid,
            name: Type.String({ minLength: 1 }),
            academicYear: Type.String({ pattern: "^[0-9]{4}/[0-9]{4}$" }),
            aiPolicy: literals(["prohibited", "partially_allowed", "encouraged"]),
            assignments: Type.Array(TeacherAssignment),
          }),
        ),
      }),
    },
  ],
  errors: [...READ_ERRORS, error(404, "not_found"), error(503, "unavailable")],
});

/** Not submitted: the three submission fields are null. */
const NotSubmitted = closed({
  studentId: Uuid,
  documentId: Type.Union([WorkId, Type.Null()]),
  submitted: Type.Literal(false),
  revision: Type.Null(),
  requestedMinute: Type.Null(),
  afterDeadline: Type.Null(),
});
const Submitted = closed({
  studentId: Uuid,
  documentId: Type.Union([WorkId, Type.Null()]),
  submitted: Type.Literal(true),
  revision: Count(0),
  requestedMinute: Minute,
  afterDeadline: Type.Boolean(),
});

export const teacherSubmissionsGet = defineRoute({
  id: "teacher.submissions.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/submissions",
  inventory: "app/api/teacher/assignments/[assignmentId]/submissions/route.ts",
  access: "course_teacher",
  summary:
    "Which students of an assignment submitted, with the work each row links to, for the assignment's teacher; one row per student with an open membership, by student id. Anyone else, an unknown or a malformed id gets the same empty list. No text, name, exact time, deadline, hash or submission id.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the submissions, possibly none",
      body: closed({ submissions: Type.Array(Type.Union([NotSubmitted, Submitted])) }),
    },
  ],
  errors: [...READ_ERRORS, error(503, "unavailable")],
});

/** MentoredWork: the student is null when the account has no name pair, never a stand-in. */
const MentoredWork = closed({
  mentorshipId: Uuid,
  assignmentId: Uuid,
  documentId: Type.Union([WorkId, Type.Null()]),
  student: Type.Union([
    closed({
      givenName: Type.String({ minLength: 1, maxLength: 510 }),
      familyName: Type.String({ minLength: 1, maxLength: 510 }),
    }),
    Type.Null(),
  ]),
  title: Type.String({ minLength: 1 }),
  workType: literals(["bachelor_thesis", "master_thesis", "specialist_thesis", "doctoral_thesis"]),
  workState: literals(["not_started", "in_progress", "submitted"]),
});

export const teacherMentorshipsGet = defineRoute({
  id: "teacher.mentorships.get",
  method: "GET",
  path: "/api/v1/teacher/mentorships",
  inventory: "app/api/teacher/mentorships/route.ts",
  access: "mentor_teacher",
  summary:
    "The open mentorships of the caller as mentor, newest first; anyone else gets the same empty list. No time, activity or count of a work.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the mentored works, possibly none",
      body: closed({ works: Type.Array(MentoredWork) }),
    },
  ],
  errors: [...READ_ERRORS, error(503, "unavailable")],
});

export const teacherMentorshipGet = defineRoute({
  id: "teacher.mentorship.get",
  method: "GET",
  path: "/api/v1/teacher/mentorships/{mentorshipId}",
  inventory: "app/api/teacher/mentorships/[mentorshipId]/route.ts",
  access: "mentor_teacher",
  summary:
    "One open mentorship of the caller as mentor. Another institution's, an ended one, an unknown and a malformed id all read the same 404.",
  request: { params: closed({ mentorshipId: Type.String({ minLength: 1 }) }) },
  responses: [{ status: 200, description: "the work", body: closed({ work: MentoredWork }) }],
  errors: [...READ_ERRORS, error(404, "not_found"), error(503, "unavailable")],
});

/** A student of the fast path (#757): both names null when the account has none. */
const FastPathStudent = Type.Union([
  closed({
    id: Uuid,
    givenName: Type.Union([Type.String({ minLength: 1, maxLength: 510 }), Type.Null()]),
    surname: Type.Union([Type.String({ minLength: 1, maxLength: 510 }), Type.Null()]),
    documentId: Type.Null(),
    work: Type.Literal("notice_pending"),
    lastChangeAt: Type.Null(),
    record: Type.Null(),
  }),
  closed({
    id: Uuid,
    givenName: Type.Union([Type.String({ minLength: 1, maxLength: 510 }), Type.Null()]),
    surname: Type.Union([Type.String({ minLength: 1, maxLength: 510 }), Type.Null()]),
    documentId: WorkId,
    work: literals(["writing", "submitted"]),
    lastChangeAt: Type.Union([SummaryMinute, Type.Null()]),
    record: closed({
      pastesWithoutSource: Count(0),
      blocks: Type.Array(
        closed({
          kind: literals(["heading", "paragraph", "bulletItem", "quote"]),
          text: Type.String(),
        }),
      ),
      summary: ProcessSummaryV1,
    }),
  }),
]);

export const teacherFastPathPost = defineRoute({
  id: "teacher.fast-path.post",
  method: "POST",
  path: "/api/v1/teacher/fast-path",
  inventory: "app/api/teacher/fast-path/route.ts",
  access: "course_teacher",
  summary:
    "The teacher's fast path through the works of one assignment (B-11, #757): per student the state of the work, its text as blocks and the same process summary the student sees. POST so the assignment id never lands in a URL; the body is exactly {assignmentId}, at most 1 KiB. An assignment the caller does not teach, an unknown or a malformed one, is the same empty list, never 403 or 404. Named students by surname, given name (hr) and id, then the unnamed by id.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ assignmentId: Type.String({ minLength: 1 }) }),
  },
  responses: [
    {
      status: 200,
      description: "the students, possibly none",
      body: closed({ kind: Type.Literal("ok"), students: Type.Array(FastPathStudent) }),
    },
  ],
  errors: [
    error(403, "origin_missing"),
    error(403, "origin_mismatch"),
    error(403, "cross_site"),
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(413, "body_too_large"),
    error(408, "body_timeout"),
    error(400, "content_length_invalid"),
    error(400, "content_length_mismatch"),
    error(400, "body_stream_error"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const teacherRoutes = [
  teacherCoursesGet,
  teacherSubmissionsGet,
  teacherMentorshipsGet,
  teacherMentorshipGet,
  teacherFastPathPost,
] as const;
