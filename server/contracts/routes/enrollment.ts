import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// Literal port of Ductus 078c780: src/server/institution/enrollment-route.ts
// (enrolment with a course code), acknowledgment-route.ts (the assignment
// notice, DAN-306) and work-language-route.ts with mutation-route.ts (the
// language of the works, DAN-386). Who may do what is the RPC's decision; the
// caller comes only from the session. The work language routes are served
// by server/http/institution-courses.ts and the acknowledgment by
// server/http/acknowledgment.ts; enrolment has no handler yet (CONTRACT_ONLY).

/** A UUID in any case (mutation-route.ts, acknowledgment-route.ts UUID /i). */
const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const Language = Type.Union([Type.Literal("hr"), Type.Literal("en")]);
const Version = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

export const enrollmentsPost = defineRoute({
  id: "institution.enrollments.post",
  method: "POST",
  path: "/api/v1/institution/enrollments",
  inventory: "app/api/institution/enrollments/route.ts",
  access: "signed_in",
  summary:
    "Enrols the caller in the course of a code. The body is exactly {code}, at most 64 UTF-16 units and 1 KiB, sent as application/json (charset utf-8 only). A wrong or expired code is 422 refused; too many guesses are 429 too_many_attempts, and each guess counts even when refused.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ code: Type.String({ maxLength: 64 }) }),
  },
  responses: [{ status: 200, description: "enrolled", body: closed({ courseId: Uuid }) }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(422, "refused"),
    error(429, "too_many_attempts"),
    error(403, "forbidden"),
    error(503, "unavailable"),
  ],
});

// SRV-02 (Ductus#2028 c.7008147932, answer A-2): enrolment with every outcome
// told apart. A route of its own, because a new error of
// institution.enrollments.post would break its clients on API v1
// (server/contracts/breaking.ts); that route stays as it is.
export const studentEnrollmentsPost = defineRoute({
  id: "student.enrollments.post",
  method: "POST",
  path: "/api/v1/student/enrollments",
  inventory: "app/api/student/enrollments/route.ts",
  access: "signed_in",
  summary:
    "Enrols the caller in the course of a code. The body is exactly {code}, at most 64 UTF-16 units and 1 KiB, sent as application/json (charset utf-8 only). The server normalizes the code (white space and hyphens removed, upper case); what is left must be 8 to 32 letters and digits, else it is invalid_code. outcome: enrolled; already_enrolled, the caller is a student of that course already and nothing changed; enrolled_no_assignment, enrolled in a course without an assignment yet. A code no course of the caller's institution has is 422 invalid_code; a code whose validity has ended is 422 expired_code. Too many guesses are 429 too_many_attempts, and each invalid or expired guess counts. The identity comes from the session only.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ code: Type.String({ maxLength: 64 }) }),
  },
  responses: [
    {
      status: 200,
      description: "enrolled, already enrolled, or enrolled in a course without an assignment",
      body: closed({
        outcome: Type.Union([
          Type.Literal("enrolled"),
          Type.Literal("already_enrolled"),
          Type.Literal("enrolled_no_assignment"),
        ]),
        courseId: Uuid,
      }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(422, "invalid_code"),
    error(422, "expired_code"),
    error(429, "too_many_attempts"),
    error(403, "forbidden"),
    error(503, "unavailable"),
  ],
});

export const acknowledgmentPost = defineRoute({
  id: "institution.acknowledgment.post",
  method: "POST",
  path: "/api/v1/institution/assignments/{assignmentId}/acknowledgment",
  inventory: "app/api/institution/assignments/[assignmentId]/acknowledgment/route.ts",
  access: "student_enrolled",
  summary:
    "The student acknowledges the notice of an assignment version they were shown. The body is exactly {versionNo, fingerprint}: the version and the SHA-256 the browser computed of the notice text, at most 1 KiB, sent as application/json (charset utf-8 only), with no escape and no repeated key. A malformed assignment id is 400 invalid_assignment_id, judged before the session. A version that is no longer current is 409 conflict; a stored notice other than the one shown is 409 notice_changed, and nothing is recorded.",
  request: {
    params: closed({ assignmentId: Type.String({ minLength: 1 }) }),
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ versionNo: Version, fingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }) }),
  },
  responses: [
    {
      status: 200,
      description: "acknowledged",
      body: closed({
        acknowledgedAt: Type.String({
          pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
        }),
      }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(400, "invalid_assignment_id"),
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(409, "notice_changed"),
    error(503, "unavailable"),
  ],
});

/** The refusals the language routes share (work-language-route.ts REFUSAL, readJsonMutation). */
const LANGUAGE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(422, "invalid_input"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(409, "conflict"),
  error(503, "unavailable"),
] as const;

export const workLanguagePost = defineRoute({
  id: "institution.work-language.post",
  method: "POST",
  path: "/api/v1/institution/assignments/{assignmentId}/work-language",
  inventory: "app/api/institution/assignments/[assignmentId]/work-language/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment sets the language its works are written in, against the version they saw: {expectedVersion, language}, at most 128 bytes, sent as application/json (only the media type before any parameter is judged). A malformed assignment id is 422; a stale version or a work already asked to be submitted is 409 conflict. Answers the new version.",
  request: {
    params: closed({ assignmentId: Uuid }),
    contentType: "application/json",
    maxBodyBytes: 128,
    body: closed({ expectedVersion: Version, language: Language }),
  },
  responses: [{ status: 200, description: "the new version", body: closed({ version: Version }) }],
  errors: [...LANGUAGE_ERRORS],
});

export const studentWorkLanguagePost = defineRoute({
  id: "institution.student-work-language.post",
  method: "POST",
  path: "/api/v1/institution/assignments/{assignmentId}/students/{studentId}/work-language",
  inventory:
    "app/api/institution/assignments/[assignmentId]/students/[studentId]/work-language/route.ts",
  access: "course_teacher",
  summary:
    "One work's exception from the language of its assignment, keyed by the student; {language: null} removes it. At most 128 bytes. Answers the language the work has afterwards.",
  request: {
    params: closed({ assignmentId: Uuid, studentId: Uuid }),
    contentType: "application/json",
    maxBodyBytes: 128,
    body: closed({ language: Type.Union([Language, Type.Null()]) }),
  },
  responses: [
    {
      status: 200,
      description: "the language the work has now",
      body: closed({ language: Language }),
    },
  ],
  errors: [...LANGUAGE_ERRORS],
});

export const workWorkLanguagePost = defineRoute({
  id: "institution.work-work-language.post",
  method: "POST",
  path: "/api/v1/institution/assignments/{assignmentId}/works/{documentId}/work-language",
  inventory:
    "app/api/institution/assignments/[assignmentId]/works/[documentId]/work-language/route.ts",
  access: "course_teacher",
  summary:
    "The same exception keyed by the work's document id, so the student's id never reaches the browser; a document that is not a work of this teacher's assignment is refused like another teacher's (403). A malformed document id is 422, judged after the content type and the body.",
  request: {
    params: closed({ assignmentId: Uuid, documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 128,
    body: closed({ language: Type.Union([Language, Type.Null()]) }),
  },
  responses: [
    {
      status: 200,
      description: "the language the work has now",
      body: closed({ language: Language }),
    },
  ],
  errors: [...LANGUAGE_ERRORS],
});

export const enrollmentRoutes = [
  enrollmentsPost,
  studentEnrollmentsPost,
  acknowledgmentPost,
  workLanguagePost,
  studentWorkLanguagePost,
  workWorkLanguagePost,
] as const;
