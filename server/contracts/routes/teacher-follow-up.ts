import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-NF4-POTVRDE-DORADE (Ductus#2055): a separate route beside
// teacher.assignment-overview.get, whose closed body stays as it is (a new
// field in an existing route is a major release, scripts/release/README.md).
// The same students as the overview, from the same database reach.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** A whole UTC minute. */
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
/** The start of a five-minute UTC window (P-03), as collaboration.revision-requests. */
const FiveMinutes = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d[05]:00\\.000Z$" });
const Count = (minimum: number) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });

const NOTICE = [
  { noticeAcknowledgedAt: Minute, noticeVersionNo: Count(1) },
  { noticeAcknowledgedAt: Type.Null(), noticeVersionNo: Type.Null() },
] as const;
const REVISION = [
  {
    revisionState: Type.Union(
      (["open", "responded", "closed", "withdrawn"] as const).map((s) => Type.Literal(s)),
    ),
    revisionChangedAt: FiveMinutes,
  },
  { revisionState: Type.Null(), revisionChangedAt: Type.Null() },
] as const;
const FollowUpStudent = Type.Union(
  NOTICE.flatMap((notice) =>
    REVISION.map((revision) =>
      closed({
        studentId: Uuid,
        noticeReadAt: Type.Union([Minute, Type.Null()]),
        ...notice,
        ...revision,
        openRevisionCount: Count(0),
      }),
    ),
  ),
);

export const teacherAssignmentFollowUpGet = defineRoute({
  id: "teacher.assignment-follow-up.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/follow-up",
  inventory: "app/api/teacher/assignments/[assignmentId]/follow-up/route.ts",
  access: "course_teacher",
  summary:
    "For each student of the assignment's overview: when the notice was first read and when its latest acknowledged version was acknowledged (UTC minutes), and the revision request with the latest change among the student's works (its state and the five-minute window of that change), with the number of open requests. There is no deadline of a revision. This read opens no work and returns no text of a request. An inaccessible, unknown or malformed assignment id returns the same empty list as an assignment with no students.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "students, possibly none",
      body: closed({ students: Type.Array(FollowUpStudent) }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});
