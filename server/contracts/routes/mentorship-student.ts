// SRV-1414 (Plan M2, D-204; supplement to SRV-1407): the two reads of the
// student's side of mentorship. The moves of a request are
// mentorship.requests.post and the per-request routes in mentorship.ts.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { END, Name } from "./teacher.ts";

/** Lowercase UUID, as the database returns it. */
const Uuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
const WorkType = Type.Union([
  Type.Literal("bachelor_thesis"),
  Type.Literal("master_thesis"),
  Type.Literal("specialist_thesis"),
  Type.Literal("doctoral_thesis"),
]);
/** The teacher's name pair, or null when the institution holds none. */
const TeacherName = Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]);
const ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(503, "unavailable"),
] as const;

const common = {
  requestId: Uuid,
  teacherId: Uuid,
  teacherName: TeacherName,
  workType: WorkType,
  requestedAt: Instant,
};
/** One request; endedAt is the instant of the one end, mentorshipId only on approval. */
export const StudentMentorshipRequest = Type.Union([
  closed({
    ...common,
    state: Type.Literal("requested"),
    endedAt: Type.Null(),
    mentorshipId: Type.Null(),
  }),
  closed({ ...common, state: Type.Literal("approved"), endedAt: Instant, mentorshipId: Uuid }),
  closed({
    ...common,
    state: Type.Literal("declined"),
    endedAt: Instant,
    mentorshipId: Type.Null(),
  }),
  closed({
    ...common,
    state: Type.Literal("withdrawn"),
    endedAt: Instant,
    mentorshipId: Type.Null(),
  }),
]);

export const MentorCandidate = closed({
  teacherId: Uuid,
  name: TeacherName,
  /** No source holds a teacher's department yet, so it is always null for now. */
  department: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
});

export const mentorshipStudentRoutes = [
  defineRoute({
    id: "mentorship.student-requests.get",
    method: "GET",
    path: "/api/v1/student/mentorship-requests",
    inventory: "app/api/student/mentorship-requests/route.ts",
    access: "student",
    summary:
      "The caller's own mentorship requests in every state, newest first, each with the teacher asked, the kind of work and the instants. The decline reason stays in the audit record (P-6). A caller with a confirmed teacher role is 403.",
    request: {},
    responses: [
      {
        status: 200,
        description: "own requests, possibly none",
        body: closed({ requests: Type.Array(StudentMentorshipRequest) }),
        headers: ["cache-control"],
      },
    ],
    errors: ERRORS,
  }),
  defineRoute({
    id: "mentorship.student-mentor-candidates.get",
    method: "GET",
    path: "/api/v1/student/mentor-candidates",
    inventory: "app/api/student/mentor-candidates/route.ts",
    access: "student",
    summary:
      "The confirmed, unrevoked teachers of the caller's own institution, other than the caller: exactly the teachers mentorship.requests.post accepts. Only the account, the name pair and the department; never an address or another personal datum. Ordered by family name, given name and id. A caller with a confirmed teacher role is 403.",
    request: {},
    responses: [
      {
        status: 200,
        description: "teachers the caller may ask, possibly none",
        body: closed({ candidates: Type.Array(MentorCandidate) }),
        headers: ["cache-control"],
      },
    ],
    errors: ERRORS,
  }),
] as const;
