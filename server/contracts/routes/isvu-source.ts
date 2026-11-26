import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { ROSTER_IMPORT_MAX_ROWS, ROSTER_IMPORT_REASONS } from "./roster-import.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-V22-ISVU-POPIS (Ductus val 22, WEB docs/nalazi/val22-razlika.md §3 t. 2,
// t. 3 and §4 t. 2; contract docs/contracts/isvu-v1.md): the administrator
// reads the courses of the TRIAL source and previews the students enrolled in
// one of them, then confirms with the existing
// institution.roster-import-confirm.post.
//
// The source is the synthetic ISVU adapter (server/external/isvu): invented
// courses and students, no network, no secret. It is not the interface of ISVU
// or of Srce, and nothing here reads one. The setting of the institution
// (config/faculties/<faculty>/isvu.json) is off by default and in production;
// when it is off both routes answer the existing 404 not_found, so they do not
// reveal that an integration exists, and no new error code is added. Students
// are matched to accounts only by their AAI@EduHr identifier, never by name
// (the database's decision, institution.preview_roster_import).
//
// The preview answer is the one of institution.roster-imports.post, with
// source always "isvu"; the lines of the rows count from 2 as there. No grade
// is read or written here (PG-10).

/** At most this many courses in one answer; the trial source has a handful. */
export const ISVU_COURSES_MAX = 200;

const END = "(?![\\s\\S])";
const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const LowerUuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Count = Type.Integer({ minimum: 0, maximum: ROSTER_IMPORT_MAX_ROWS });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/** The academic year as the trial source names it: 2026/2027. */
const AcademicYear = Type.String({ pattern: `^\\d{4}/\\d{4}${END}` });
/** The source's own key of a course: letters, digits, dot, hyphen, underscore. */
const SourceCourseKey = Type.String({ pattern: `^[A-Za-z0-9._-]{1,64}${END}` });

const Cell = (maxLength: number) => Type.String({ maxLength });
const ROW_CELLS = {
  line: Type.Integer({ minimum: 2 }),
  identifier: Cell(255),
  givenName: Cell(200),
  familyName: Cell(200),
};
const PreviewRow = Type.Union([
  closed({ ...ROW_CELLS, status: Type.Literal("new"), reason: Type.Null() }),
  closed({ ...ROW_CELLS, status: Type.Literal("already_enrolled"), reason: Type.Null() }),
  closed({
    ...ROW_CELLS,
    status: Type.Literal("unsuitable"),
    reason: literals(ROSTER_IMPORT_REASONS),
  }),
]);

const GET_ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(422, "invalid_input"),
  error(503, "unavailable"),
] as const;

const POST_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(422, "invalid_input"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const isvuCoursesGet = defineRoute({
  id: "institution.isvu-courses.get",
  method: "GET",
  path: "/api/v1/institution/admin/isvu/courses",
  inventory: "app/api/institution/admin/isvu/courses/route.ts",
  access: "institution_admin",
  summary:
    "The courses of the TRIAL ISVU source of the caller's institution for an administrator (val 22). The source is an invented one with invented courses and students, not ISVU and not any interface of Srce; nothing leaves the server. Query: exactly academicYear (for example 2026/2027), any other parameter or a missing or malformed value is 422. Answer: mode (always mock) and the courses of that year, each with its sourceCourseKey, name, academicYear and enrolledCount (the number of students the source lists; no names). Only an administrator of the institution (403 otherwise). When the institution's ISVU setting is off, which is the default and always the case in production, the answer is the ordinary 404 not_found, so the integration is not revealed.",
  request: { query: closed({ academicYear: AcademicYear }) },
  responses: [
    {
      status: 200,
      description: "the courses of the trial source",
      body: closed({
        mode: Type.Literal("mock"),
        courses: Type.Array(
          closed({
            sourceCourseKey: SourceCourseKey,
            name: Cell(200),
            academicYear: AcademicYear,
            enrolledCount: Count,
          }),
          { maxItems: ISVU_COURSES_MAX },
        ),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: GET_ERRORS,
});

export const isvuRosterImportsPost = defineRoute({
  id: "institution.isvu-roster-imports.post",
  method: "POST",
  path: "/api/v1/institution/admin/courses/{courseId}/isvu-roster-imports",
  inventory: "app/api/institution/admin/courses/[courseId]/isvu-roster-imports/route.ts",
  access: "institution_admin",
  summary:
    "Step one of the import of a course's students from the TRIAL ISVU source (val 22): the preview. Exactly {sourceCourseKey} as application/json, at most 1 KiB. The server reads the students of that course from the trial source and previews them as institution.roster-imports.post previews a file, with the same answer (source is isvu; the lines count from 2): every row is new, already_enrolled or unsuitable with a reason, matched to an account only by its AAI@EduHr identifier, never by name. Nothing is enrolled. importId confirms it with institution.roster-import-confirm.post until expiresAt (30 minutes), as for a file. A sourceCourseKey the source does not know, a course that is not the institution's and an institution whose ISVU setting is off (the default, and always in production) are the ordinary 404 not_found; a body that is not exactly a valid key is 422. Only an administrator of the institution (403 otherwise).",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    params: closed({ courseId: Uuid }),
    body: closed({ sourceCourseKey: SourceCourseKey }),
  },
  responses: [
    {
      status: 200,
      description: "the preview; nothing enrolled",
      body: closed({
        importId: LowerUuid,
        source: Type.Literal("isvu"),
        expiresAt: Instant,
        counts: closed({ new: Count, alreadyEnrolled: Count, unsuitable: Count }),
        rows: Type.Array(PreviewRow, { maxItems: ROSTER_IMPORT_MAX_ROWS }),
      }),
    },
  ],
  errors: POST_ERRORS,
});

export const isvuSourceRoutes = [isvuCoursesGet, isvuRosterImportsPost] as const;
