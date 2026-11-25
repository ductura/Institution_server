import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1108 (Ductus#2028, Val 11, N-13, C-15, PO-22): the teacher of an
// assignment extends its deadline for one student or for all of them, with a
// reason from the closed list of N-13. A record is never changed or removed;
// an extension never changes a submission already recorded. The reason is
// private: a list shows it only on the records the caller wrote. Database:
// institution.extend_assignment_deadline and institution.deadline_extensions
// (20261121106000).

/** Lowercase UUID. */
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const AnyCaseUuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/** N-13 EXT_REASONS: Opravdan razlog, Tehnička poteškoća, Dogovor s nastavnikom, Produljenje za sve. */
export const DEADLINE_EXTENSION_REASONS = ["justified", "technical", "agreement", "all"] as const;
const ReasonId = literals(DEADLINE_EXTENSION_REASONS);

const Extension = closed({
  id: Uuid,
  scope: literals(["one", "all"]),
  studentId: Type.Union([Uuid, Type.Null()]),
  previousDueAt: Instant,
  dueAt: Instant,
  /** Null on a record another teacher wrote. */
  reasonId: Type.Union([ReasonId, Type.Null()]),
  createdBy: Uuid,
  createdAt: Instant,
});

const AssignmentParams = closed({ assignmentId: Type.String({ minLength: 1 }) });

export const teacherDeadlineExtensionsGet = defineRoute({
  id: "teacher.deadline-extensions.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/deadline-extensions",
  inventory: "app/api/teacher/assignments/[assignmentId]/deadline-extensions/route.ts",
  access: "course_teacher",
  summary:
    "The deadline extensions of an assignment, oldest first, for its teacher. reasonId is null on a record another teacher wrote. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the extensions, possibly none",
      body: closed({ extensions: Type.Array(Extension) }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherDeadlineExtensionPost = defineRoute({
  id: "teacher.deadline-extension.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/deadline-extensions",
  inventory: "app/api/teacher/assignments/[assignmentId]/deadline-extensions/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment extends its deadline for one student of it (scope one) or for all (scope all). dueAt must be later than the deadline in force; the reason all is only for scope all. existingSubmissionsUnchanged is true when a submission in the scope was already recorded: the extension leaves it as it is. Success follows the database commit. An inaccessible assignment or student returns 404; invalid input or an earlier deadline 422.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: Type.Union([
      closed({
        scope: Type.Literal("one"),
        studentId: AnyCaseUuid,
        dueAt: Instant,
        reasonId: literals(["justified", "technical", "agreement"]),
      }),
      closed({ scope: Type.Literal("all"), dueAt: Instant, reasonId: ReasonId }),
    ]),
  },
  responses: [
    {
      status: 201,
      description: "the recorded extension",
      body: closed({ extension: Extension, existingSubmissionsUnchanged: Type.Boolean() }),
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
    error(503, "unavailable"),
  ],
});

export const studentDeadlineHistoryGet = defineRoute({
  id: "student.deadline-history.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/deadline-extensions",
  inventory: "app/api/student/assignments/[assignmentId]/deadline-extensions/route.ts",
  access: "student_enrolled",
  summary:
    "The caller's individual and assignment-wide extensions, oldest first. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the student's extensions, possibly empty",
      body: closed({
        extensions: Type.Array(
          closed({
            id: Uuid,
            scope: literals(["one", "all"]),
            previousDueAt: Instant,
            dueAt: Instant,
            reasonId: ReasonId,
            createdAt: Instant,
          }),
        ),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

// SRV-NF4-IZNIMKA-ZAPIS (Ductus#2055, plan NF-4, NZ-5 B): the exception of a
// late submission for one student, a record of its own beside the extensions.
// It changes no deadline: it says the student may still submit until a time.
// The reason is from the closed list of N-13 (no "all", no free text); a record
// is never changed or removed; the grant and its audit row are one command.
// Database: institution.grant_late_submission_exception and
// institution.late_submission_exception (20261219290000). Honouring it at a
// submission is SRV-NF4-IZNIMKA-PREDAJA.

/** The reasons of an exception: those of an extension for one student. */
export const LATE_EXCEPTION_REASONS = ["justified", "technical", "agreement"] as const;
const ExceptionReasonId = literals(LATE_EXCEPTION_REASONS);

const LateException = closed({
  id: Uuid,
  studentId: Uuid,
  untilAt: Instant,
  /** Null on a record another teacher wrote. */
  reasonId: Type.Union([ExceptionReasonId, Type.Null()]),
  createdBy: Uuid,
  createdAt: Instant,
});

export const teacherLateExceptionsGet = defineRoute({
  id: "teacher.late-exceptions.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/late-submission-exceptions",
  inventory: "app/api/teacher/assignments/[assignmentId]/late-submission-exceptions/route.ts",
  access: "course_teacher",
  summary:
    "The late-submission exceptions of an assignment, oldest first, for its teacher. reasonId is null on a record another teacher wrote. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the exceptions, possibly none",
      body: closed({ exceptions: Type.Array(LateException) }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherLateExceptionPost = defineRoute({
  id: "teacher.late-exception.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/late-submission-exceptions",
  inventory: "app/api/teacher/assignments/[assignmentId]/late-submission-exceptions/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment records that one student of it may still submit until untilAt, with a reason from the closed list. untilAt must be later than now, than the deadline that holds for the student and than the student's earlier exception. The record is never changed or removed and its audit row is written by the same command. Success follows the database commit. An inaccessible assignment or student returns 404; invalid input or a time that is not later 422.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: closed({ studentId: AnyCaseUuid, untilAt: Instant, reasonId: ExceptionReasonId }),
  },
  responses: [
    {
      status: 201,
      description: "the recorded exception",
      body: closed({ exception: LateException }),
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
    error(503, "unavailable"),
  ],
});

export const studentLateExceptionsGet = defineRoute({
  id: "student.late-exceptions.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/late-submission-exceptions",
  inventory: "app/api/student/assignments/[assignmentId]/late-submission-exceptions/route.ts",
  access: "student_enrolled",
  summary:
    "The caller's own late-submission exceptions, oldest first; each carries kind exception, the mark the student sees. Nothing of another student. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the student's exceptions, possibly empty",
      body: closed({
        exceptions: Type.Array(
          closed({
            id: Uuid,
            kind: Type.Literal("exception"),
            untilAt: Instant,
            reasonId: ExceptionReasonId,
            createdAt: Instant,
          }),
        ),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const deadlineExtensionRoutes = [
  teacherDeadlineExtensionsGet,
  teacherDeadlineExtensionPost,
  studentDeadlineHistoryGet,
  teacherLateExceptionsGet,
  teacherLateExceptionPost,
  studentLateExceptionsGet,
] as const;
