// SRV-1412 (Plan M2.1 to M2.3; DAN-330, DAN-331, DAN-309): the student starts
// the own work on an assignment, and reads the own works ("Moji radovi").
// A work is made only on start (F-137), once per student and assignment: a
// second start answers the same work. The projection carries only the
// caller's own work and what the student is shown of the assignment; nothing
// of a teacher (no grade, note, accommodation, criteria) and no other person.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { DocumentKind, WorkKind, MUTATION_GUARD } from "./shared.ts";
import { END } from "./teacher.ts";

/** Lowercase UUID, as the database returns it. */
const Uuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
/** The work id: the id of the work's document (server/contracts/work-id.ts). */
const WorkId = Type.String({ minLength: 1, maxLength: 256 });
/** The language of the work (F-06), not of the interface. */
const WorkLanguage = Type.Union([Type.Literal("hr"), Type.Literal("en")]);
/** The version of the institution's rules the assignment is pinned to; null before any. */
const RulesVersion = Type.Union([
  Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  Type.Null(),
]);
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const StudentWork = closed({
  workId: WorkId,
  assignmentId: Uuid,
  assignmentTitle: Type.String({ minLength: 1 }),
  courseId: Uuid,
  courseName: Type.String({ minLength: 1 }),
  /** The academic year, as `2026/2027`. */
  academicYear: Type.String({ pattern: `^\\d{4}/\\d{4}${END}` }),
  /** The caller's due time: a personal extension, else the current version's. */
  dueAt: Instant,
  state: Type.Union([Type.Literal("in_progress"), Type.Literal("submitted")]),
  /** The revision of the saved text. */
  revision: Count,
  /** When the submission was asked for; null while in progress. */
  submittedAt: Type.Union([Instant, Type.Null()]),
  language: WorkLanguage,
  /** The kind of the work (SRV-V13-UGOVOR-VRSTA); absent means text. */
  documentKind: Type.Optional(DocumentKind),
  workKind: Type.Optional(WorkKind),
  /**
   * F4 1.6: the assignment's current notice is newer than the newest one the
   * student confirmed. False when nothing changed and when the student never
   * confirmed one. Absent from an older server.
   */
  noticeChangedSinceSeen: Type.Optional(Type.Boolean()),
  /**
   * Once a submission is recorded: it was asked for after the student's due
   * time of that moment. Absent while no submission is recorded.
   */
  afterDeadline: Type.Optional(Type.Boolean()),
});

export const studentWorkRoutes = [
  defineRoute({
    id: "student-work.start.post",
    method: "POST",
    path: "/api/v1/assignments/{assignmentId}/start",
    inventory: "app/api/assignments/[assignmentId]/start/route.ts",
    access: "student_enrolled",
    summary:
      "Starts the caller's own work on an assignment of their open student membership, or answers the one already started: at most one work per student and assignment, so a second start answers the same workId and writes nothing. Answers the work id, the version of the institution's rules the assignment is pinned to (null for an assignment made before any) and the language of the work. No body. Another course's assignment, an unknown one and a malformed id are the same 404 (C-23); a notice not yet acknowledged or an assignment not yet open is 409 conflict and nothing is written; an institution without one evidence domain is 503.",
    request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
    responses: [
      {
        status: 200,
        description: "the caller's work, started now or before",
        body: closed({
          workId: WorkId,
          rulesVersion: RulesVersion,
          language: WorkLanguage,
          documentKind: Type.Optional(DocumentKind),
          workKind: Type.Optional(WorkKind),
        }),
        headers: ["cache-control"],
      },
    ],
    errors: [
      ...MUTATION_GUARD,
      error(401, "unauthorized"),
      error(404, "not_found"),
      error(409, "conflict"),
      error(503, "unavailable"),
    ],
  }),
  defineRoute({
    id: "student-work.works.get",
    method: "GET",
    path: "/api/v1/student/works",
    inventory: "app/api/student/works/route.ts",
    access: "student",
    summary:
      "The caller's own started works on the assignments of their open student memberships, by due time, then assignment id: the assignment and course as the student sees them, the caller's due time, state, revision, submission time and work language. Nothing of a teacher (grade, note, accommodation, criteria) and no other person. A caller with no work gets an empty list.",
    request: {},
    responses: [
      {
        status: 200,
        description: "own works, possibly none",
        body: closed({ works: Type.Array(StudentWork) }),
        headers: ["cache-control"],
      },
    ],
    errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
  }),
] as const;
