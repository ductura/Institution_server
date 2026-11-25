import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SignedSubmissionReceipt } from "./evidence.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END, Name, StudentSubmissionState } from "./teacher.ts";

export { StudentSubmissionState };

// Literal port of Ductus 078c780 src/components/student/my-assignments-read.ts
// (#711, "Moji zadaci"): Ductus reads it in a server component, so the route
// is born here (SERVER_SOURCES). MyAssignmentsRead maps onto the wire as
// ready -> 200 {courses}, signedOut -> 401 unauthorized, unavailable -> 503.
// The list is never partial: a row that is not what the query returns makes
// the whole answer 503.

const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

/** ISO 8601 UTC (Date.toISOString); Ductus accepts only UTC years 1000 to 9999 (validInstant). */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

// SRV-02 (Ductus#2028 c.7008147932, answer A-3): what "Moji zadaci" shows of a
// course and an assignment. Each new member is optional on the wire, because
// API v1 takes only optional new response fields (server/contracts/breaking.ts);
// a server of @ductura/contracts 3.0.0 sends every one of them.
const Person = { id: Uuid, givenName: Name, familyName: Name };
/** A teacher of the course: its holder, or a collaborator (another teacher of the course team). */
const CourseTeacher = closed({
  ...Person,
  role: Type.Union([Type.Literal("holder"), Type.Literal("collaborator")]),
});
/** A seminar group of the course the caller is in now. */
const MyGroup = closed({ id: Uuid, name: Type.String({ minLength: 1 }) });
const WorkType = Type.Union(
  [
    ...["short_paper", "essay", "seminar_paper", "bachelor_thesis", "master_thesis"],
    ...["specialist_thesis", "doctoral_thesis"],
  ].map((value) => Type.Literal(value)),
);

const MyAssignment = closed({
  id: Uuid,
  title: Type.String({ minLength: 1 }),
  /** Due time of the current version. */
  dueAt: Instant,
  /** The current version's notice is not acknowledged yet; the work opens it first. */
  noticeFirst: Type.Boolean(),
  workType: Type.Optional(WorkType),
  /** The caller's mentor for this assignment, or null when the work has none. */
  mentor: Type.Optional(Type.Union([closed(Person), Type.Null()])),
  /** A later due time granted to the caller alone, or null; never earlier than dueAt. */
  extendedDueAt: Type.Optional(Type.Union([Instant, Type.Null()])),
});

const MyCourse = closed({
  id: Uuid,
  name: Type.String({ minLength: 1 }),
  /** The academic year, as `2026/2027`. */
  academicYear: Type.Optional(Type.String({ pattern: "^\\d{4}/\\d{4}$" })),
  /** The caller's open seminar groups of the course, by name; possibly none. */
  groups: Type.Optional(Type.Array(MyGroup)),
  /** The course's teachers: the holder first, then collaborators by family and given name (hr collation), then id. */
  teachers: Type.Optional(Type.Array(CourseTeacher)),
  assignments: Type.Array(MyAssignment),
});

export const studentAssignmentsGet = defineRoute({
  id: "student.assignments.get",
  method: "GET",
  path: "/api/v1/student/assignments",
  inventory: "app/api/student/assignments/route.ts",
  access: "signed_in",
  summary:
    "The courses of the caller's open student memberships and the current version of every assignment in each. Courses by name (hr collation), then id; assignments by due time, then id. The identity comes from the session only.",
  request: {},
  responses: [
    {
      status: 200,
      description: "ready (an empty list when the student has no course)",
      body: closed({ courses: Type.Array(MyCourse) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

// DAN-904: Ductus 4eaa776 src/server/privacy/my-access-log-pages.ts
// (readMyAccessLogPage), which Ductus reads in a page, not a route; the rows
// as the port server/database/my-access-log.ts (DAN-859) reads them.
// A day of the proleptic Gregorian calendar, years 0001 to 9999 (PostgreSQL
// has no year zero): the days of each month and 29 February only in a leap
// year (QA #256 c.6948938937).
const YEAR = "(?!0000)\\d{4}";
const LEAP_YEAR =
  "(?!0000)(?:\\d\\d(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)";
const MONTH_DAY = [
  "(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])",
  "(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)",
  "02-(?:0[1-9]|1\\d|2[0-8])",
].join("|");
const DAY = `(?:${YEAR}-(?:${MONTH_DAY})|${LEAP_YEAR}-02-29)`;
/** The start of a five-minute window as Date.toISOString gives it. */
const Window = Type.String({
  pattern: `^${DAY}T(?:[01]\\d|2[0-3]):[0-5][05]:00\\.000Z${END}`,
});
const RowId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const oneOf = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));

export const studentAccessLogGet = defineRoute({
  id: "student.access-log.get",
  method: "GET",
  path: "/api/v1/student/works/{documentId}/access-log",
  inventory: "app/api/student/works/[documentId]/access-log/route.ts",
  access: "student_owner",
  summary:
    "Who opened the caller's own work and when (PRODUCT §5 rule 17): one entry per stored opening of five minutes, newest first; the client groups them into Europe/Zagreb days. No total of visits and no duration (D-274 MQ10). The query names the oldest entry shown, beforeAt and beforeId from next; a page from it holds only windows strictly older. Only both together, on the five-minute grid, a lowercase UUID, not in the future and not before year one are a cursor; anything else, and any other parameter, reads the first page with continued false, never an error, so every opening stays reachable. Another's work, an unknown and a malformed id read the same 404 (C-23). A row the read cannot vouch for makes the whole answer 503.",
  request: {
    params: closed({ documentId: Type.String({ minLength: 1 }) }),
    query: Type.Object({
      beforeAt: Type.Optional(Type.String()),
      beforeId: Type.Optional(Type.String()),
    }),
  },
  responses: [
    {
      status: 200,
      description: "a page of openings, possibly none",
      body: closed({
        entries: Type.Array(
          closed({
            id: RowId,
            at: Window,
            role: oneOf(["teacher", "mentor", "seminar_teacher", "unknown"]),
            surface: oneOf([
              ...["live_view", "process_summary", "fast_path", "replay", "submitted_text"],
              "unknown",
            ]),
            /** Null when the reader has no name pair; never a stand-in. */
            reader: Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]),
          }),
        ),
        next: Type.Union([closed({ beforeAt: Window, beforeId: RowId }), Type.Null()]),
        /** Read from a checked cursor. */
        continued: Type.Boolean(),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

// DAN-989-1 (Ductus#1836 UGOVOR w989a): the state of the caller's own work
// per assignment, a route of its own because a new member of
// student.assignments.get is a major release of @ductura/contracts
// (scripts/release/README.md, QA #92). The words are those of
// teacher.mentorships.get. The client joins it to student.assignments.get
// by assignments[].id = assignmentId, both lowercase (PostgreSQL's uuid text).
const LowerUuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});

export const studentAssignmentWorkGet = defineRoute({
  id: "student.assignment-work.get",
  method: "GET",
  path: "/api/v1/student/assignment-work",
  inventory: "app/api/student/assignment-work/route.ts",
  access: "signed_in",
  summary:
    "The state of the caller's own work for every assignment student.assignments.get would list at the same instant: one row per assignment, by assignmentId (lowercase). submitted: the caller has a recorded submission for the assignment, of any of its versions; in_progress: the caller has a work for it (one per student and assignment) and no recorded submission; not_started: no work. The two reads are separate, so a client joins them by lowercase id and shows no state for an assignment without a row on both sides. The identity comes from the session only. A row the read cannot vouch for makes the whole answer 503, never a partial list.",
  request: {},
  responses: [
    {
      status: 200,
      description: "ready (an empty list when the student has no course)",
      body: closed({
        assignments: Type.Array(
          closed({
            assignmentId: LowerUuid,
            workState: oneOf(["not_started", "in_progress", "submitted"]),
            // SRV-NF4-IZNIMKA-PREDAJA (NF-4, NZ-5 B). Optional only because a new
            // required field breaks clients (server/contracts/breaking.ts), and the
            // summary stays as it was for the same reason.
            lateException: Type.Optional(
              Type.Object(
                { untilAt: Instant },
                {
                  additionalProperties: false,
                  description:
                    "The caller's own latest late-submission exception on the assignment: the teacher's record that this student may still submit until untilAt although the deadline has passed, even when late submission is not allowed (a submission then is still after the deadline). Absent when the caller has none; sent also after untilAt, so a client compares untilAt with the time. Another student's exception is never in the answer.",
                },
              ),
            ),
          }),
        ),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

// SRV-02 (Ductus#2028 c.7008147932, PO-7): the student has opened the notice
// of an assignment version, before acknowledging it. A record of reading only:
// it opens no work and replaces no acknowledgment (institution.acknowledgment.post).
export const studentNoticeReadPost = defineRoute({
  id: "student.notice-read.post",
  method: "POST",
  path: "/api/v1/student/assignments/{assignmentId}/notice-read",
  inventory: "app/api/student/assignments/[assignmentId]/notice-read/route.ts",
  access: "student_enrolled",
  summary:
    "Records that the caller read the notice of the given version of an assignment of their open student membership (PO-7). The body is exactly {versionNo}, at most 128 bytes, sent as application/json (charset utf-8 only). Idempotent: a repeated call answers the first readAt. A malformed assignment id is 400 invalid_assignment_id, judged before the session; another's assignment and an unknown one are the same 404 (C-23); a version that is no longer current is 409 conflict and nothing is recorded.",
  request: {
    params: closed({ assignmentId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 128,
    body: closed({ versionNo: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) }),
  },
  responses: [
    {
      status: 200,
      description: "read (now or before)",
      body: closed({ readAt: Instant }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(400, "invalid_assignment_id"),
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

// UGOVORI-API (Ductus#2028 c.7019543739, approved as SRV-NG in c.7019668458):
// the notice of the current version of an assignment, as E-6 shows it before
// the work opens. Every member of the notice fingerprint (DAN-306,
// server/domain/notice/fingerprint.ts NOTICE_FINGERPRINT_FIELDS) is here, so
// the browser computes the fingerprint it acknowledges from exactly what it
// showed; the fingerprint itself is never sent. No handler yet (CONTRACT_ONLY).
const AiPurpose = oneOf([
  ...["formatting", "proofreading", "literature_search", "transcription", "translation"],
]);
const WordCount = Type.Integer({ minimum: 1, maximum: 1_000_000 });
const WordBound = Type.Union([WordCount, Type.Null()]);

export const studentNoticeGet = defineRoute({
  id: "student.notice.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/notice",
  inventory: "app/api/student/assignments/[assignmentId]/notice/route.ts",
  access: "student_enrolled",
  summary:
    "The notice of the current version of an assignment of the caller's open student membership (E-6): the content of that version as the notice shows it, the notice template version, and when the caller first read it (PO-7, student.notice-read.post) and acknowledged it (institution.acknowledgment.post), each null until then. The fields are exactly those of the notice fingerprint (DAN-306), instants as Date.toISOString writes them; the browser computes the fingerprint from them and sends it with versionNo to institution.acknowledgment.post. aiPurposes is empty when aiPolicy is prohibited. The identity comes from the session only. Sec-Fetch-Site, when sent, other than same-origin is 403. Another's assignment, an unknown one and a malformed id are the same 404 (C-23). A row the read cannot vouch for makes the whole answer 503.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the notice",
      body: closed({
        assignmentId: LowerUuid,
        versionNo: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        /** NOTICE_TEMPLATE_VERSION of the static text the notice shows around these fields. */
        templateVersion: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        title: Type.String({ minLength: 1 }),
        instructions: Type.String(),
        workType: WorkType,
        opensAt: Instant,
        dueAt: Instant,
        aiPolicy: oneOf(["prohibited", "partially_allowed", "encouraged"]),
        aiPurposes: Type.Array(AiPurpose, { maxItems: 5 }),
        evidenceProfile: oneOf(["basic", "extended"]),
        wordMin: WordBound,
        wordMax: WordBound,
        readAt: Type.Union([Instant, Type.Null()]),
        acknowledgedAt: Type.Union([Instant, Type.Null()]),
        /**
         * SRV-ASIST-CITANJE (Ductus#2055): the purpose catalog of this version,
         * whose keys aiPurposes names; the assistant request sends it back as
         * purposeCatalogVersion. Not a member of the notice fingerprint.
         */
        purposeCatalogVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

// SRV-19 adds routes because a new member of an existing closed body would
// require a major release of @ductura/contracts.
const assignmentParams = closed({ assignmentId: Type.String({ minLength: 1 }) });
const assignmentReadErrors = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const studentSubmissionGet = defineRoute({
  id: "student.submission.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/submission",
  inventory: "app/api/student/assignments/[assignmentId]/submission/route.ts",
  access: "student_enrolled",
  summary:
    "The caller's submission for this assignment. An accessible assignment with no submission returns none. ceka means the submission was recorded but no signed receipt is attached yet. potvrdeno carries the same signed receipt as submission.submit.post. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: assignmentParams },
  responses: [{ status: 200, description: "submission state", body: StudentSubmissionState }],
  errors: assignmentReadErrors,
});

const WordRange = Type.Union([
  closed({ min: WordCount, max: WordBound }),
  closed({ min: Type.Null(), max: WordCount }),
  Type.Null(),
]);

export const studentAssignmentRequirementsGet = defineRoute({
  id: "student.assignment-requirements.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/requirements",
  inventory: "app/api/student/assignments/[assignmentId]/requirements/route.ts",
  access: "student_enrolled",
  summary:
    "The word range of the current assignment version. A null bound leaves that end open; when both bounds are present min is at most max. A null range means neither bound is set. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: assignmentParams },
  responses: [{ status: 200, description: "word range", body: closed({ wordRange: WordRange }) }],
  errors: assignmentReadErrors,
});

// SRV-NF1-PREDANO (Ductus#2055, NF-1 P-6): when each own submission was confirmed, for the
// whole list at once. A route of its own, not two fields of student.assignment-work.get: a
// new member of an existing route is a major release of @ductura/contracts
// (scripts/release/README.md, QA #92). The values are those of the signed receipt
// (receipt.payload.requestedAt and .afterDeadline), so the list never says more than
// student.submission.get would for the same assignment.
/** isSubmissionInstant: the database clock with exactly six fraction digits, in UTC. */
const Microsecond = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$",
});

export const studentAssignmentSubmissionsGet = defineRoute({
  id: "student.assignment-submissions.get",
  method: "GET",
  path: "/api/v1/student/assignment-submissions",
  inventory: "app/api/student/assignment-submissions/route.ts",
  access: "signed_in",
  summary:
    "When the caller's own submission was confirmed, for every assignment student.assignment-work.get would list at the same instant: one row per assignment, by assignmentId (lowercase). With a signed receipt, submittedAt and afterDeadline are receipt.payload.requestedAt and receipt.payload.afterDeadline of the receipt student.submission.get returns. With no submission, a withdrawn one or one still waiting for its receipt (ceka), both are null. The identity comes from the session only, so the list holds only the caller's own assignments. A row or a receipt the read cannot vouch for makes the whole answer 503, never a partial list.",
  request: {},
  responses: [
    {
      status: 200,
      description: "ready (an empty list when the student has no course)",
      body: closed({
        assignments: Type.Array(
          Type.Union([
            closed({
              assignmentId: LowerUuid,
              submittedAt: Microsecond,
              afterDeadline: Type.Boolean(),
            }),
            closed({
              assignmentId: LowerUuid,
              submittedAt: Type.Null(),
              afterDeadline: Type.Null(),
            }),
          ]),
        ),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

const NoteText = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,600}${END}`,
});
const SubmissionNote = closed({ id: LowerUuid, text: NoteText, createdAt: Instant });

export const studentSubmissionNotesGet = defineRoute({
  id: "student.submission-notes.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/submission-notes",
  inventory: "app/api/student/assignments/[assignmentId]/submission-notes/route.ts",
  access: "student_enrolled",
  summary: "The caller's notes for an accessible assignment, oldest first, then by id.",
  request: { params: assignmentParams },
  responses: [
    {
      status: 200,
      description: "notes, possibly empty",
      body: closed({ notes: Type.Array(SubmissionNote) }),
    },
  ],
  errors: assignmentReadErrors,
});

export const studentSubmissionNotesPost = defineRoute({
  id: "student.submission-notes.post",
  method: "POST",
  path: "/api/v1/student/submission-notes",
  inventory: "app/api/student/submission-notes/route.ts",
  access: "student_enrolled",
  summary:
    "Adds a note for the caller's assignment. The text has 1 to 600 Unicode code points and contains a non-whitespace character. Notes are append-only and stay separate from the submission and signed receipt.",
  request: {
    contentType: "application/json",
    // Fits 600 supplementary characters even when sent as escaped surrogate pairs.
    maxBodyBytes: 8192,
    body: closed({ assignmentId: LowerUuid, text: NoteText }),
  },
  responses: [{ status: 201, description: "added note", body: SubmissionNote }],
  errors: [
    ...MUTATION_GUARD,
    ...assignmentReadErrors,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
  ],
});

export const studentRoutes = [
  studentAssignmentsGet,
  studentAccessLogGet,
  studentAssignmentWorkGet,
  studentNoticeReadPost,
  studentNoticeGet,
  studentSubmissionGet,
  studentAssignmentRequirementsGet,
  studentAssignmentSubmissionsGet,
  studentSubmissionNotesGet,
  studentSubmissionNotesPost,
] as const;
