import { Type, type TSchema } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SignedSubmissionReceipt } from "./evidence.ts";
import { Minute as SummaryMinute, ProcessSummaryV1 } from "./process-summary-shape.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { teacherDeclarationGet } from "./teacher-declaration.ts";
import { teacherSubmissionDetailGet } from "./teacher-submissions.ts";

// Literal port of Ductus 078c780: src/server/institution/teacher-courses.ts
// (DAN-230), src/server/evidence/assignment-submissions.ts (DAN-332 R1) and
// src/server/institution/mentored-works.ts (DAN-477). Who asks comes only from
// the session; the database decides which rows. Each read answers for all of
// its rows: a row it cannot vouch for makes the whole answer 503, never a
// partial list. A cross-site read (Sec-Fetch-Site other than same-origin) is
// 403. The courses, mentorship and submission reads are served by
// server/http/teacher-reads.ts, which also serves access. The fast path has no handler yet
// (CONTRACT_ONLY).

/** Lowercase UUID, as the Ductus UUID check of these reads. */
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** A whole UTC minute. */
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
// One code point: a surrogate pair or any other UTF-16 unit outside the
// surrogates. Without the u flag (TypeBox compiles `new RegExp(pattern)`) this
// still counts code points; an engine with full Unicode strings reads the pair
// branch as never used. A lone surrogate is refused (the database cannot store it).
export const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** The end of the text: unlike `$`, never before a final line end in any engine. */
export const END = "(?![\\s\\S])";

/**
 * A work id (evidence.document.id, server/contracts/work-id.ts): 1 to 256 code
 * points, no control character (C0, DEL, C1), no white space at either end.
 */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/** A name of the login claims (isName): 1 to 255 code points. */
export const Name = Type.String({
  pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,255}${END}`,
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

const StudentName = Type.Union([
  closed({
    givenName: Name,
    familyName: Name,
  }),
  Type.Null(),
]);

const MentorshipWorkType = literals([
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
]);

/**
 * MentoredWork: the student is null when the account has no name pair, never
 * a stand-in. The work state follows the work: not started without one, in
 * progress or submitted with one (mentoredWorkOf refuses anything else).
 */
const mentoredWork = (documentId: TSchema, workState: TSchema) =>
  closed({
    mentorshipId: Uuid,
    assignmentId: Uuid,
    documentId,
    student: StudentName,
    title: Type.String({ minLength: 1 }),
    workType: MentorshipWorkType,
    workState,
  });
const MentoredWork = Type.Union([
  mentoredWork(Type.Null(), Type.Literal("not_started")),
  mentoredWork(WorkId, literals(["in_progress", "submitted"])),
]);

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

/** Both names, or both null when the account has no name pair (#757 D1); never one alone. */
const NAMES = [
  {
    givenName: Name,
    surname: Name,
  },
  { givenName: Type.Null(), surname: Type.Null() },
] as const;

const PendingWork = {
  documentId: Type.Null(),
  work: Type.Literal("notice_pending"),
  lastChangeAt: Type.Null(),
  record: Type.Null(),
};
const StartedWork = {
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
};

/** A student of the fast path (#757): a record exactly when there is a work. */
const FastPathStudent = Type.Union(
  NAMES.flatMap((names) =>
    [PendingWork, StartedWork].map((work) => closed({ id: Uuid, ...names, ...work })),
  ),
);

export const teacherFastPathPost = defineRoute({
  id: "teacher.fast-path.post",
  method: "POST",
  path: "/api/v1/teacher/fast-path",
  inventory: "app/api/teacher/fast-path/route.ts",
  access: "course_teacher",
  summary:
    "The teacher's fast path through the works of one assignment (B-11, #757): per student the state of the work, its text as blocks and the same process summary the student sees. POST so the assignment id never lands in a URL; the body is exactly {assignmentId}, a UUID in any case, at most 1 KiB; any other key or a malformed id is 422 invalid_input. An assignment the caller does not teach, or that does not exist, is the same empty list, never 403 or 404. Named students by surname, given name (hr) and id, then the unnamed by id.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({
      assignmentId: Type.String({
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      }),
    }),
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

/** A UUID in any case, as fast-path; the server reads it in lowercase. */
const AnyCaseUuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

// DAN-903-1: Ductus 4eaa776 src/server/evidence/assignment-submissions.ts
// readAssignmentSubmissionsMany (F-142, R1), which Ductus calls from its
// teacher page, not from a route. Two deliberate departures (Ductus#1836
// c.6947962506): a malformed id is 422, not left out, and the list has a bound.
export const teacherAssignmentSubmissionsPost = defineRoute({
  id: "teacher.assignment-submissions.post",
  method: "POST",
  path: "/api/v1/teacher/assignment-submissions",
  inventory: "app/api/teacher/assignment-submissions/route.ts",
  access: "course_teacher",
  summary:
    "teacher.submissions.get for many assignments in one snapshot (R1): one entry per distinct id, lowercase, in the order of first appearance. POST so the ids never land in a URL; the body is exactly {assignmentIds}, 0 to 500 UUIDs in any case (duplicates count), at most 32 KiB; any other key or a malformed id is 422 invalid_input. An assignment the caller does not teach, or that does not exist, is the same entry with an empty list, never 403 or 404; proving that over the database belongs to the handler. More than 500 assignments take several reads, each its own snapshot. A row the read cannot vouch for makes the whole answer 503.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 32768,
    body: closed({ assignmentIds: Type.Array(AnyCaseUuid, { maxItems: 500 }) }),
  },
  responses: [
    {
      status: 200,
      description: "an entry per assignment, possibly with no rows",
      body: closed({
        assignments: Type.Array(
          closed({
            assignmentId: Uuid,
            submissions: Type.Array(Type.Union([NotSubmitted, Submitted])),
          }),
        ),
      }),
    },
  ],
  errors: teacherFastPathPost.errors,
});

// DAN-903-2: Ductus 4eaa776 src/components/teacher/teacher-access.ts
// (teacherPageRead, B-7), which Ductus reads in its teacher pages, not in a route.
export const teacherAccessGet = defineRoute({
  id: "teacher.access.get",
  method: "GET",
  path: "/api/v1/teacher/access",
  inventory: "app/api/teacher/access/route.ts",
  access: "signed_in",
  summary:
    "Whether the caller may see the teacher pages: a confirmed and unrevoked institution role (institution.actor_has_role('teacher')), never the login claims. The session and the role come from one snapshot, so denied is always an open session without the role and allowed always comes with a signed-in principal. scope is principalScope, for the shell of the teacher pages only; it is not the general source of the principal. No session is 401, a database that cannot be asked 503. Names no course, assignment or count: the role alone gives no access to a work (C-23).",
  request: {},
  responses: [
    {
      status: 200,
      description: "allowed or denied",
      body: closed({
        access: literals(["allowed", "denied"]),
        scope: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      }),
    },
  ],
  errors: [...READ_ERRORS, error(503, "unavailable")],
});

// SRV-27 (Ductus#2028 c.7009405737) adds separate routes to keep existing closed bodies stable.
const LIST_ERRORS = [...READ_ERRORS, error(503, "unavailable")] as const;
const STUDENT_NAME_FIELDS = [
  { givenName: Name, familyName: Name },
  { givenName: Type.Null(), familyName: Type.Null() },
] as const;
const GroupName = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const ListedAssignmentWork = closed({
  assignmentId: Uuid,
  documentId: Type.Union([WorkId, Type.Null()]),
  workState: literals(["not_started", "in_progress", "submitted"]),
});
const CourseStudent = Type.Union(
  STUDENT_NAME_FIELDS.map((names) =>
    closed({
      studentId: Uuid,
      ...names,
      groupName: GroupName,
      assignments: Type.Array(ListedAssignmentWork),
    }),
  ),
);

export const teacherCourseStudentsGet = defineRoute({
  id: "teacher.course-students.get",
  method: "GET",
  path: "/api/v1/teacher/courses/{courseId}/students",
  inventory: "app/api/teacher/courses/[courseId]/students/route.ts",
  access: "course_teacher",
  summary:
    "The course roster and the state of each student's work per assignment. Course teachers see the course; group teachers see their own groups. A missing name pair or group is null. A document id links to the work when one exists. An inaccessible, unknown or malformed course id returns the same empty list as a course with no students.",
  request: { params: closed({ courseId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "students, possibly none",
      body: closed({ students: Type.Array(CourseStudent) }),
      headers: ["cache-control"],
    },
  ],
  errors: LIST_ERRORS,
});

const EvidenceRecord = SignedSubmissionReceipt.properties.payload.properties.evidenceRecord;
const OVERVIEW_STATES = [
  {
    submitted: Type.Literal(false),
    requestedMinute: Type.Null(),
    afterDeadline: Type.Null(),
    evidenceRecord: Type.Null(),
  },
  {
    submitted: Type.Literal(true),
    requestedMinute: Submitted.properties.requestedMinute,
    afterDeadline: Submitted.properties.afterDeadline,
    evidenceRecord: Type.Union([EvidenceRecord, Type.Null()]),
  },
] as const;
const AssignmentOverviewStudent = Type.Union(
  STUDENT_NAME_FIELDS.flatMap((names) =>
    OVERVIEW_STATES.map((state) =>
      closed({ studentId: Uuid, ...names, groupName: GroupName, ...state }),
    ),
  ),
);

export const teacherAssignmentOverviewGet = defineRoute({
  id: "teacher.assignment-overview.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/overview",
  inventory: "app/api/teacher/assignments/[assignmentId]/overview/route.ts",
  access: "course_teacher",
  summary:
    "Submission overview for each student visible to the caller, with a UTC minute and the record state from the signed receipt. A recorded submission awaiting its receipt has a null evidenceRecord. This read opens no work and returns no work text, hash or submission id. An inaccessible, unknown or malformed assignment id returns the same empty list as an assignment with no students.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "students, possibly none",
      body: closed({ students: Type.Array(AssignmentOverviewStudent) }),
      headers: ["cache-control"],
    },
  ],
  errors: LIST_ERRORS,
});

const { revision, requestedAt } = SignedSubmissionReceipt.properties.payload.properties;
export const StudentSubmissionState = Type.Union([
  closed({ state: Type.Literal("none") }),
  closed({ state: Type.Literal("ceka"), revision, requestedAt }),
  closed({ state: Type.Literal("potvrdeno"), receipt: SignedSubmissionReceipt }),
]);

export const teacherSubmissionReceiptGet = defineRoute({
  id: "teacher.submission-receipt.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission",
  inventory: "app/api/teacher/assignments/[assignmentId]/students/[studentId]/submission/route.ts",
  access: "course_teacher",
  summary:
    "The same submission state and signed receipt as student.submission.get, for a student the caller may read. The read has no work content and writes nothing to the access log (P-5). Inaccessible, unknown and malformed ids return the same 404.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "submission state",
      body: StudentSubmissionState,
      headers: ["cache-control"],
    },
  ],
  errors: [...LIST_ERRORS, error(404, "not_found")],
});

export const teacherMentorshipRequestsGet = defineRoute({
  id: "teacher.mentorship-requests.get",
  method: "GET",
  path: "/api/v1/teacher/mentorship-requests",
  inventory: "app/api/teacher/mentorship-requests/route.ts",
  access: "teacher",
  summary:
    "The open mentorship requests made to the confirmed, unrevoked teacher in the caller's institution. A student without a name pair has a null name. The decision reason stays in the audit record.",
  request: {},
  responses: [
    {
      status: 200,
      description: "open requests, possibly none",
      body: closed({
        requests: Type.Array(
          closed({
            requestId: Uuid,
            student: StudentName,
            workType: MentorshipWorkType,
            requestedAt: Instant,
          }),
        ),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: LIST_ERRORS,
});

const DecisionReason = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,600}${END}`,
});

export const teacherMentorshipRequestDecisionPost = defineRoute({
  id: "teacher.mentorship-request-decision.post",
  method: "POST",
  path: "/api/v1/teacher/mentorship-requests/decision",
  inventory: "app/api/teacher/mentorship-requests/decision/route.ts",
  access: "teacher",
  summary:
    "The confirmed teacher to whom an open request was made approves or declines it. An optional decline reason has 1 to 600 Unicode code points and contains a non-whitespace character. It is kept in the audit record. Success follows the database commit; a closed request returns 409.",
  request: {
    contentType: "application/json",
    // Large enough for 600 supplementary code points sent as escaped pairs.
    maxBodyBytes: 8192,
    body: Type.Union([
      closed({ requestId: AnyCaseUuid, decision: Type.Literal("approve") }),
      closed({
        requestId: AnyCaseUuid,
        decision: Type.Literal("decline"),
        reason: Type.Optional(DecisionReason),
      }),
    ]),
  },
  responses: [
    {
      status: 200,
      description: "committed decision",
      body: Type.Union([
        closed({ decision: Type.Literal("approve"), mentorshipId: Uuid }),
        closed({ decision: Type.Literal("decline") }),
      ]),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    ...LIST_ERRORS,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(409, "conflict"),
  ],
});

export const teacherRoutes = [
  teacherCoursesGet,
  teacherSubmissionsGet,
  teacherSubmissionDetailGet,
  teacherDeclarationGet,
  teacherMentorshipsGet,
  teacherMentorshipGet,
  teacherFastPathPost,
  teacherAssignmentSubmissionsPost,
  teacherAccessGet,
  teacherCourseStudentsGet,
  teacherAssignmentOverviewGet,
  teacherSubmissionReceiptGet,
  teacherMentorshipRequestsGet,
  teacherMentorshipRequestDecisionPost,
] as const;
