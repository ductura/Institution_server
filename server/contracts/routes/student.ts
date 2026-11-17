import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { END, Name } from "./teacher.ts";

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

export const studentRoutes = [studentAssignmentsGet, studentAccessLogGet] as const;
