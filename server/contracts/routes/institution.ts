import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// Literal port of Ductus 078c780: src/server/institution/create-course.ts,
// assignment-version-route.ts with create-assignment.ts (the content of a
// version), enrollment-code-route.ts, enrollment-code-revocation-route.ts,
// student-removal-route.ts, student-return-route.ts and the two teacher role
// routes, all in front of mutation-route.ts. Who may do what is the decision
// of the SECURITY DEFINER RPC behind each; the caller comes only from the
// session. No handler yet (CONTRACT_ONLY).

/** A UUID in any case (mutation-route.ts UUID /i). */
const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const END = "(?![\\s\\S])";
const MAX_VERSION = 2_147_483_647;
/**
 * One code point as Array.from counts it: a surrogate pair, a lone surrogate
 * or any other unit. The three are disjoint, so a long string never
 * backtracks between them.
 */
const codePoint = (excluded: string) =>
  `(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|[^\\uD800-\\uDBFF${excluded}])`;
const AiPolicy = Type.Union([
  Type.Literal("prohibited"),
  Type.Literal("partially_allowed"),
  Type.Literal("encouraged"),
]);

/**
 * The refusals of every route in front of readJsonMutation: the guard, the
 * session's shape, a malformed path id or body (422), the content type, the
 * body frame, JSON, and rpcErrorResponse (401, 403, else 503).
 */
const MUTATION_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(422, "invalid_input"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(503, "unavailable"),
] as const;

/**
 * Exactly {} (readEmptyMutation). maxProperties says it: closed({}) compiles to
 * [].includes(key), which TypeScript types as never.
 */
const EMPTY_BODY = {
  contentType: "application/json",
  maxBodyBytes: 64,
  body: Type.Object({}, { maxProperties: 0 }),
} as const;

export const coursesPost = defineRoute({
  id: "institution.courses.post",
  method: "POST",
  path: "/api/v1/institution/courses",
  inventory: "app/api/institution/courses/route.ts",
  access: "teacher",
  summary:
    "A teacher creates a course in their institution: exactly {name, academicYear, aiPolicy}, at most 2 KiB, sent as application/json (only the media type before any parameter is judged). The name is 1 to 160 UTF-16 units with no space at either end; the academic year is two consecutive years such as 2026/2027. The same course sent again answers its id, never a second course.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 2048,
    body: closed({
      name: Type.String({
        minLength: 1,
        maxLength: 160,
        pattern: `^(?!\\s)[\\s\\S]*(?<!\\s)${END}`,
      }),
      academicYear: Type.String({ pattern: `^[0-9]{4}/[0-9]{4}${END}` }),
      aiPolicy: AiPolicy,
    }),
  },
  responses: [{ status: 200, description: "the course", body: closed({ id: Uuid }) }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

/** A word bound of institution.is_word_range, or null for none. */
const WordBound = Type.Union([Type.Integer({ minimum: 1, maximum: 1_000_000 }), Type.Null()]);
/** ISO_INSTANT of create-assignment.ts; the calendar and the UTC years 1000 to 9999 are the server's. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,6})?(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))${END}`,
});

export const assignmentVersionsPost = defineRoute({
  id: "institution.assignment-versions.post",
  method: "POST",
  path: "/api/v1/institution/assignments/{assignmentId}/versions",
  inventory: "app/api/institution/assignments/[assignmentId]/versions/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment publishes its next version against the version they saw: {expectedVersion} and the whole content, both word bounds named (null drops one), at most 90 000 bytes. A tightening of the rules, an AI purpose under a prohibited policy, wordMin above wordMax or an impossible date is 422; a stale version is 409 version_conflict, and of two requests with the same version one writes.",
  request: {
    params: closed({ assignmentId: Uuid }),
    contentType: "application/json",
    maxBodyBytes: 90_000,
    body: closed({
      expectedVersion: Type.Integer({ minimum: 1, maximum: MAX_VERSION }),
      title: Type.String({ pattern: `^(?:${codePoint("\\u0000")}){1,200}${END}` }),
      instructions: Type.String({ pattern: `^(?:${codePoint("\\u0000")}){0,20000}${END}` }),
      workType: Type.Union(
        [
          "short_paper",
          "essay",
          "seminar_paper",
          "bachelor_thesis",
          "master_thesis",
          "specialist_thesis",
          "doctoral_thesis",
        ].map((type) => Type.Literal(type)),
      ),
      opensAt: Instant,
      dueAt: Instant,
      aiPolicy: AiPolicy,
      aiPurposes: Type.Array(
        Type.Union(
          ["formatting", "proofreading", "literature_search", "transcription", "translation"].map(
            (purpose) => Type.Literal(purpose),
          ),
        ),
        // Repeated purposes are the server's 422: TypeBox checks uniqueItems with a hash the
        // generated validator does not carry.
        { maxItems: 5 },
      ),
      evidenceProfile: Type.Union([Type.Literal("basic"), Type.Literal("extended")]),
      importAllowed: Type.Boolean(),
      wordMin: WordBound,
      wordMax: WordBound,
    }),
  },
  responses: [
    {
      status: 201,
      description: "published",
      body: closed({
        assignmentId: Type.String({
          pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        }),
        versionNo: Type.Integer({ minimum: 2, maximum: MAX_VERSION }),
      }),
    },
  ],
  errors: [...MUTATION_ERRORS, error(409, "version_conflict")],
});

export const enrollmentCodePost = defineRoute({
  id: "institution.enrollment-code.post",
  method: "POST",
  path: "/api/v1/institution/courses/{courseId}/enrollment-code",
  inventory: "app/api/institution/courses/[courseId]/enrollment-code/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the course issues its enrolment code, valid until {validUntil}, replacing any earlier one; at most 1 KiB. The instant keeps its offset and fraction as sent; an impossible date or one the database refuses is 422.",
  request: {
    params: closed({ courseId: Uuid }),
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({
      validUntil: Type.String({
        pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|[+-]\\d{2}:\\d{2})${END}`,
      }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the code",
      body: closed({ code: Type.String({ pattern: "^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$" }) }),
    },
  ],
  errors: [...MUTATION_ERRORS],
});

export const enrollmentCodeRevocationPost = defineRoute({
  id: "institution.enrollment-code-revocation.post",
  method: "POST",
  path: "/api/v1/institution/courses/{courseId}/enrollment-code/revocation",
  inventory: "app/api/institution/courses/[courseId]/enrollment-code/revocation/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the course revokes its enrolment code. The body is exactly {}; revoked is false when there was no code to revoke.",
  request: { params: closed({ courseId: Uuid }), ...EMPTY_BODY },
  responses: [
    { status: 200, description: "revoked or not", body: closed({ revoked: Type.Boolean() }) },
  ],
  errors: [...MUTATION_ERRORS],
});

export const studentRemovalPost = defineRoute({
  id: "institution.student-removal.post",
  method: "POST",
  path: "/api/v1/institution/courses/{courseId}/students/{studentId}/removal",
  inventory: "app/api/institution/courses/[courseId]/students/[studentId]/removal/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the course ends one student's membership. The body is exactly {}; removed is false when that user holds no open student membership there.",
  request: { params: closed({ courseId: Uuid, studentId: Uuid }), ...EMPTY_BODY },
  responses: [
    { status: 200, description: "removed or not", body: closed({ removed: Type.Boolean() }) },
  ],
  errors: [...MUTATION_ERRORS],
});

export const studentReturnPost = defineRoute({
  id: "institution.student-return.post",
  method: "POST",
  path: "/api/v1/institution/courses/{courseId}/students/{studentId}/return-permission",
  inventory:
    "app/api/institution/courses/[courseId]/students/[studentId]/return-permission/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the course lets one removed student enrol again; the student still needs a valid code. The body is exactly {}; allowed is false when nothing was blocking that student there.",
  request: { params: closed({ courseId: Uuid, studentId: Uuid }), ...EMPTY_BODY },
  responses: [
    { status: 200, description: "allowed or not", body: closed({ allowed: Type.Boolean() }) },
  ],
  errors: [...MUTATION_ERRORS],
});

export const roleConfirmationPost = defineRoute({
  id: "institution.role-confirmation.post",
  method: "POST",
  path: "/api/v1/institution/teachers/{teacherId}/role-confirmation",
  inventory: "app/api/institution/teachers/[teacherId]/role-confirmation/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution confirms one candidate as a teacher. The body is exactly {}. A caller who is not an administrator is 403; for an administrator every candidate that cannot be confirmed (themself, another institution's, a missing one, one whose last login gave no right) is the same 404.",
  request: { params: closed({ teacherId: Uuid }), ...EMPTY_BODY },
  responses: [
    { status: 200, description: "confirmed", body: closed({ confirmed: Type.Literal(true) }) },
  ],
  errors: [...MUTATION_ERRORS, error(404, "not_found")],
});

export const roleRevocationPost = defineRoute({
  id: "institution.role-revocation.post",
  method: "POST",
  path: "/api/v1/institution/teachers/{teacherId}/role-revocation",
  inventory: "app/api/institution/teachers/[teacherId]/role-revocation/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution ends one person's confirmed teacher role. The body is exactly {}; revoked is false when that person holds no active confirmed teacher role in the caller's institution, so another institution's person looks the same as a missing one.",
  request: { params: closed({ teacherId: Uuid }), ...EMPTY_BODY },
  responses: [
    { status: 200, description: "revoked or not", body: closed({ revoked: Type.Boolean() }) },
  ],
  errors: [...MUTATION_ERRORS],
});

/** Lowercase UUID, as the UUID check of Ductus institution-courses.ts. */
const LowerUuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Two consecutive years such as 2026/2027 (isAcademicYear; the order a schema cannot say). */
const AcademicYear = Type.String({ pattern: `^[0-9]{4}/[0-9]{4}${END}` });
/** A course or group name as is_plain_label stored it: 1 to 200 code points, no control character. */
const Label = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)${codePoint("\\u0000-\\u001f\\u007f-\\u009f")}{1,200}${END}`,
});
/** A name of the login claims (isName): 1 to 255 code points, no control character (C0, DEL, C1). */
const PersonName = Type.String({
  pattern: `^${codePoint("\\u0000-\\u001f\\u007f-\\u009f")}{1,255}${END}`,
});
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** The name is null when the account has no name pair in the institution, never a stand-in. */
const CoursePerson = closed({
  personId: LowerUuid,
  name: Type.Union([closed({ givenName: PersonName, familyName: PersonName }), Type.Null()]),
});
/** The reads of the administrator's course screen (A-03): no input but the session and the year. */
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(503, "unavailable"),
] as const;

// Port of Ductus 70c168f src/server/institution/institution-courses.ts (DAN-313,
// screen A-03), which the page reads without a route.ts. Only a confirmed,
// unrevoked administrator gets an answer, for their own institution; anyone
// else is 403. A row the read cannot vouch for makes the whole answer 503.
export const academicYearsGet = defineRoute({
  id: "institution.academic-years.get",
  method: "GET",
  path: "/api/v1/institution/academic-years",
  inventory: "app/api/institution/academic-years/route.ts",
  access: "institution_admin",
  summary:
    "The academic years of the administrator's institution that have a course, newest first, each once (institution.institution_academic_years). A caller who is not an administrator, or a cross-site read, is 403.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the years, possibly none",
      body: closed({ years: Type.Array(AcademicYear, { uniqueItems: true }) }),
    },
  ],
  errors: [...READ_ERRORS],
});

export const courseListGet = defineRoute({
  id: "institution.course-list.get",
  method: "GET",
  path: "/api/v1/institution/course-list",
  inventory: "app/api/institution/course-list/route.ts",
  access: "institution_admin",
  summary:
    "The courses of the administrator's institution in one academic year (institution.institution_courses): each with its number of open students, its holder, its teaching team and its seminar groups with their teachers and number of students. Students are counted, never named. Courses and groups by name (hr collation), then id; people by surname, then given name, then id, those without a name last. The query is exactly academicYear, once; anything else is 422 and reaches no database. A caller who is not an administrator, or a cross-site read, is 403.",
  request: { query: closed({ academicYear: AcademicYear }) },
  responses: [
    {
      status: 200,
      description: "the courses of the year, possibly none",
      body: closed({
        academicYear: AcademicYear,
        courses: Type.Array(
          closed({
            courseId: LowerUuid,
            name: Label,
            students: Count,
            holder: Type.Union([CoursePerson, Type.Null()]),
            team: Type.Array(CoursePerson),
            groups: Type.Array(
              closed({
                groupId: LowerUuid,
                name: Label,
                students: Count,
                teachers: Type.Array(CoursePerson),
              }),
            ),
          }),
        ),
      }),
    },
  ],
  errors: [...READ_ERRORS, error(422, "invalid_input")],
});

export const institutionRoutes = [
  coursesPost,
  assignmentVersionsPost,
  enrollmentCodePost,
  enrollmentCodeRevocationPost,
  studentRemovalPost,
  studentReturnPost,
  roleConfirmationPost,
  roleRevocationPost,
  academicYearsGet,
  courseListGet,
] as const;
