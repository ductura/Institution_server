import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DISALLOWED = "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069";
const INVISIBLE =
  "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200d\\u2028\\u2029\\u202f\\u205f\\u2060\\u3000\\ufeff";
const UUID = `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`;
const APP_VERSION = `^(?:(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})(?:\\+[0-9a-f]{7,40})?|[0-9a-f]{7,40})${END}`;

export const ProblemReportInput = closed({
  category: Type.Union([
    Type.Literal("technical"),
    Type.Literal("account"),
    Type.Literal("course"),
  ]),
  description: Type.String({
    pattern: `^(?=[\\s\\S]*[^${INVISIBLE}])(?:${CODE_POINT}|[^${DISALLOWED}\\uD800-\\uDFFF]){1,2000}${END}`,
  }),
  appVersion: Type.String({ pattern: APP_VERSION }),
  // SRV-ADMIN-1 (OA-7): a course report may name the course it is about, a
  // course of the reporter (student or team member); anything else is 422. A
  // report that names one reaches the teachers of that course.
  courseId: Type.Optional(Type.String({ pattern: UUID })),
});

export const problemReportsPost = defineRoute({
  id: "support.problem-reports.post",
  method: "POST",
  path: "/api/v1/problem-reports",
  inventory: "app/api/problem-reports/route.ts",
  access: "signed_in",
  summary:
    "Submit a problem report with up to 2000 Unicode code points and receive a reference. The limit is five reports per account in a sliding hour, shared with the support route.",
  request: { contentType: "application/json", maxBodyBytes: 32 * 1024, body: ProblemReportInput },
  responses: [
    {
      status: 201,
      description: "recorded; the reference the user quotes",
      body: closed({ reference: Type.String({ pattern: `^PR-[0-9A-F]{10}${END}` }) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(429, "too_many_reports"),
    error(503, "unavailable"),
  ],
});

// SRV-ADMIN-1 (NF-7 OA-7; owner decision 23. 11. 2026., item 8): the reports
// reach the people who answer them, by kind (20261215100000): technical to a
// network engineer of the institution, account to a confirmed administrator,
// course to the team of the named course (a course report naming no course to
// the administrator). The reader gets what the reporter wrote and the closed
// technical context, never who sent it. The database decides who reads what.

/** The most reports one answer carries, newest first; `truncated` says more exist. */
export const PROBLEM_REPORTS_PAGE = 500;

const ReportCategory = Type.Union([
  Type.Literal("technical"),
  Type.Literal("account"),
  Type.Literal("course"),
]);
const RoutedTo = Type.Union([
  Type.Literal("network_engineer"),
  Type.Literal("course_teacher"),
  Type.Literal("institution_admin"),
]);
const ReportStatus = Type.Union([Type.Literal("received"), Type.Literal("resolved")]);
/** Date.toISOString of a finite instant. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
const Reference = Type.String({ pattern: `^PR-[0-9A-F]{10}${END}` });
const SYNC_STATE = Type.Union(
  [
    "EDITING",
    "SAVING_LOCAL",
    "LOCAL_DURABLE",
    "SYNCING",
    "SYNCED",
    "CONFLICT",
    "ERROR",
    "RECOVERY_REQUIRED",
  ].map((state) => Type.Literal(state)),
);

export const RoutedProblemReport = closed({
  reference: Reference,
  category: ReportCategory,
  /** The position through which the report reaches the reader. */
  routedTo: RoutedTo,
  courseId: Type.Union([Type.String({ pattern: UUID }), Type.Null()]),
  /** The reporter's own text, as written. */
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  route: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  appVersion: Type.String({ pattern: APP_VERSION }),
  browser: closed({
    family: Type.Union([
      Type.Literal("chromium"),
      Type.Literal("firefox"),
      Type.Literal("safari"),
      Type.Literal("other"),
    ]),
    major: Type.Union([Type.Integer({ minimum: 0, maximum: 999 }), Type.Null()]),
  }),
  syncState: Type.Union([SYNC_STATE, Type.Null()]),
  createdAt: Instant,
  /** "received" until somebody the report reaches marks it "resolved". */
  status: ReportStatus,
  /** The last change of the state, null while it was never changed. */
  statusChangedAt: Type.Union([Instant, Type.Null()]),
  statusChangedByRole: Type.Union([RoutedTo, Type.Null()]),
  /** True when the last change was the reader's own; never a name. */
  statusChangedByMe: Type.Boolean(),
});

export const problemReportsGet = defineRoute({
  id: "support.problem-reports.get",
  method: "GET",
  path: "/api/v1/problem-reports",
  inventory: "app/api/problem-reports/route.ts",
  access: "signed_in",
  summary:
    "The problem reports that reach the caller, newest first, at most 500 (truncated says more exist): technical reports for a network engineer of the institution, account reports and course reports naming no course for a confirmed administrator, reports about a course for its teaching team. Each carries what the reporter wrote, the closed technical context and the state, never who sent it. An account that is none of these is 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the reports, possibly none",
      body: closed({
        reports: Type.Array(RoutedProblemReport, { maxItems: PROBLEM_REPORTS_PAGE }),
        truncated: Type.Boolean(),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const problemReportStatusPost = defineRoute({
  id: "support.problem-report-status.post",
  method: "POST",
  path: "/api/v1/problem-reports/{reference}/status",
  inventory: "app/api/problem-reports/[reference]/status/route.ts",
  access: "signed_in",
  summary:
    "Marks a report that reaches the caller received or resolved: exactly {status}, at most 256 bytes, sent as application/json. The same state again changes nothing. Every change is kept with the role of who made it. An account that reads no reports is 403; a report that does not reach the caller (another kind, course or institution, or none) is 404; a malformed reference or state is 422.",
  request: {
    params: closed({ reference: Type.String({ minLength: 1, maxLength: 64 }) }),
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ status: ReportStatus }),
  },
  responses: [
    {
      status: 200,
      description: "the current state of the report",
      body: closed({
        reference: Reference,
        status: ReportStatus,
        statusChangedAt: Type.Union([Instant, Type.Null()]),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});
