import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// Literal port of Ductus 078c780 src/components/student/my-assignments-read.ts
// (#711, "Moji zadaci"): Ductus reads it in a server component, so the route
// is born here (SERVER_SOURCES). MyAssignmentsRead maps onto the wire as
// ready -> 200 {courses}, signedOut -> 401 unauthorized, unavailable -> 503.
// The list is never partial: a row that is not what the query returns makes
// the whole answer 503.

const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

const MyAssignment = closed({
  id: Uuid,
  title: Type.String({ minLength: 1 }),
  /** Due time, ISO 8601 UTC (Date.toISOString); Ductus accepts only UTC years 1000 to 9999 (validInstant). */
  dueAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  /** The current version's notice is not acknowledged yet; the work opens it first. */
  noticeFirst: Type.Boolean(),
});

const MyCourse = closed({
  id: Uuid,
  name: Type.String({ minLength: 1 }),
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

export const studentRoutes = [studentAssignmentsGet] as const;
