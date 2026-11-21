import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { END, Name } from "./teacher.ts";

// SRV-1706 (plan M10.4, PRODUCT §5 rule 17, C4, D-274 MQ10; Ductus#2052
// c.7069036189): who opened the caller's own work and when, as rows of five
// minutes grouped into Europe/Zagreb days by the server. The rows are those of
// app.read_my_access_log (DAN-294), the same as student.access-log.get gives
// flat. Nothing in the answer counts visits or measures time: no total, no
// duration, no first or last visit, no number per day.

// A day of the proleptic Gregorian calendar, years 0001 to 9999 (PostgreSQL
// has no year zero), as in student.access-log.get.
const YEAR = "(?!0000)\\d{4}";
const LEAP_YEAR =
  "(?!0000)(?:\\d\\d(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)";
const MONTH_DAY = [
  "(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])",
  "(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)",
  "02-(?:0[1-9]|1\\d|2[0-8])",
].join("|");
const DAY = `(?:${YEAR}-(?:${MONTH_DAY})|${LEAP_YEAR}-02-29)`;
/** A Europe/Zagreb calendar day, `2026-11-10`. */
const ZagrebDay = Type.String({ pattern: `^${DAY}${END}` });
/** The start of a five-minute window as Date.toISOString gives it. */
const Window = Type.String({
  pattern: `^${DAY}T(?:[01]\\d|2[0-3]):[0-5][05]:00\\.000Z${END}`,
});
const RowId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const oneOf = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));

/** The reader roles of audit.access_log, and unknown for one this server does not know. */
export const WORK_ACCESS_ROLES = ["teacher", "mentor", "seminar_teacher", "unknown"] as const;
/** The surfaces of audit.access_log, and unknown for one this server does not know. */
export const WORK_ACCESS_SURFACES = [
  "live_view",
  "process_summary",
  "fast_path",
  "replay",
  "submitted_text",
  "declaration",
  "unknown",
] as const;

const WorkAccessRow = closed({
  id: RowId,
  /** The start of the window; the window is always five minutes. */
  at: Window,
  role: oneOf(WORK_ACCESS_ROLES),
  surface: oneOf(WORK_ACCESS_SURFACES),
  /** Null when the reader has no name pair; never a stand-in. */
  reader: Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]),
});

export const workAccessGet = defineRoute({
  id: "work.access.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/access",
  inventory: "app/api/works/[documentId]/access/route.ts",
  access: "student_owner",
  summary:
    "Who opened the caller's own work and when (PRODUCT §5 rule 17, plan M10.4): one row per stored opening of five minutes, grouped into Europe/Zagreb days, the newest day and the newest row first. Rows are never merged; there is no total of visits, no duration and no count per day (D-274 MQ10). Only the owner of the work reads it; another's work, an unknown and a malformed id read the same 404 (C-23). The query names the oldest row shown, beforeAt and beforeId from next; a page from it holds only windows strictly older, so a day can continue on the next page. Only both together, on the five-minute grid, a lowercase UUID and not in the future are a cursor; anything else, and any other parameter, reads the first page with continued false, never an error. A row the read cannot vouch for makes the whole answer 503.",
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
      description: "a page of openings in days, possibly none",
      body: closed({
        days: Type.Array(
          closed({ date: ZagrebDay, entries: Type.Array(WorkAccessRow, { minItems: 1 }) }),
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

export const accessLogRoutes = [workAccessGet] as const;
