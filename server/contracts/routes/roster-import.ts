import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-ADMIN-2 admin-uvoz-popisa (Ductus#2055, NF-7 OA-10; owner decision of
// 23 Nov 2026, t. 3): the administrator of an institution imports the list of
// students of a course from Merlin or ISVU, as CSV, in two steps. The preview
// reads the file and says of every row whether it is new, already enrolled or
// not to enrol, and why; it enrols nobody. The confirmation enrols exactly the
// preview's new rows; confirmed again it answers its first result. Enrolment
// by code (institution.enrollments.post, student.enrollments.post) is
// unchanged. Who may: the SECURITY DEFINER RPCs institution.preview_roster_import
// and institution.confirm_roster_import (20261215120000): a confirmed
// administrator of the course's institution only.
//
// The file format is a PROPOSAL waiting for an example of a real Merlin or
// ISVU export ("čeka primjer stvarnog izvoza"): UTF-8 (a byte order mark is
// dropped), the first line a header, a semicolon or comma between cells
// (whichever the header has first), RFC 4180 quotes. The header names, in any
// case: identifikator (the student's AAI@EduHr identifier,
// hrEduPersonUniqueID), ime and prezime; other columns are ignored. Both
// sources take the same format until the real exports are known.

/** The limits, also in server/institution/roster-import.ts (a test holds them equal). */
export const ROSTER_IMPORT_MAX_CSV_LENGTH = 200_000;
export const ROSTER_IMPORT_MAX_ROWS = 1000;
export const ROSTER_IMPORT_SOURCES = ["merlin", "isvu"] as const;
/** Why a row is not enrolled: three from reading the file, five from the database. */
export const ROSTER_IMPORT_REASONS = [
  "invalid_identifier",
  "missing_name",
  "duplicate",
  "unknown_account",
  "ineligible_account",
  "name_mismatch",
  "removed",
  "course_teacher",
] as const;

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

/** A cell as the file has it, trimmed and cut to its limit; never parsed further. */
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

const MUTATION_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(422, "invalid_input"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const rosterImportsPost = defineRoute({
  id: "institution.roster-imports.post",
  method: "POST",
  path: "/api/v1/institution/admin/courses/{courseId}/roster-imports",
  inventory: "app/api/institution/admin/courses/[courseId]/roster-imports/route.ts",
  access: "institution_admin",
  summary:
    "Step one of the import of a course's students from Merlin or ISVU (NF-7 OA-10): the preview. Exactly {source, csv} as application/json, at most 256 KiB; source is merlin or isvu, csv the file's text, at most 200 000 UTF-16 units and 1000 rows after the header. The format is a proposal waiting for a real export: a header with identifikator (AAI@EduHr identifier), ime and prezime in any case and order, other columns ignored, semicolon or comma, RFC 4180 quotes. Every row answers its line, its cells as the file has them (trimmed, identifier in lower case) and a status: new (an account of the institution, to enrol), already_enrolled, or unsuitable with a reason (invalid_identifier, missing_name, duplicate of an earlier row, unknown_account (no account of the institution: the student has not signed in yet), ineligible_account (an account the import never enrols; it enrols by code), name_mismatch, removed from the course by a teacher, course_teacher). Nothing is enrolled. importId confirms it with institution.roster-import-confirm.post until expiresAt (30 minutes). A file without the three columns is 422 roster_columns_missing, more rows than allowed 422 roster_too_many_rows, a quote left open 422 roster_malformed. Only an administrator of the institution (403 otherwise); a course that is not the institution's is 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256 * 1024,
    params: closed({ courseId: Uuid }),
    body: closed({
      source: literals(ROSTER_IMPORT_SOURCES),
      csv: Type.String({ maxLength: ROSTER_IMPORT_MAX_CSV_LENGTH }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the preview; nothing enrolled",
      body: closed({
        importId: LowerUuid,
        source: literals(ROSTER_IMPORT_SOURCES),
        expiresAt: Instant,
        counts: closed({ new: Count, alreadyEnrolled: Count, unsuitable: Count }),
        rows: Type.Array(PreviewRow, { maxItems: ROSTER_IMPORT_MAX_ROWS }),
      }),
    },
  ],
  errors: [
    ...MUTATION_ERRORS,
    error(422, "roster_columns_missing"),
    error(422, "roster_too_many_rows"),
    error(422, "roster_malformed"),
  ],
});

export const rosterImportConfirmPost = defineRoute({
  id: "institution.roster-import-confirm.post",
  method: "POST",
  path: "/api/v1/institution/admin/roster-imports/{importId}/confirm",
  inventory: "app/api/institution/admin/roster-imports/[importId]/confirm/route.ts",
  access: "institution_admin",
  summary:
    "Step two of the import of a course's students (NF-7 OA-10): exactly {} as application/json. The administrator confirms a preview of institution.roster-imports.post; its new rows are enrolled as students of the course, each as enrolment by code would. A student who became a member meanwhile counts as alreadyEnrolled, one a teacher removed meanwhile as skipped. Confirmed again, by any administrator of the institution, it answers its first result with alreadyConfirmed true and enrols nobody twice. A preview past its expiry is 410 import_expired (preview the file again); an import that is not the institution's is 404. Only an administrator of the institution (403 otherwise).",
  request: {
    contentType: "application/json",
    maxBodyBytes: 64,
    params: closed({ importId: Uuid }),
    body: Type.Object({}, { maxProperties: 0 }),
  },
  responses: [
    {
      status: 200,
      description: "the result of the confirmation",
      body: closed({
        enrolled: Count,
        alreadyEnrolled: Count,
        skipped: Count,
        alreadyConfirmed: Type.Boolean(),
      }),
    },
  ],
  errors: [...MUTATION_ERRORS, error(410, "import_expired")],
});

export const rosterImportRoutes = [rosterImportsPost, rosterImportConfirmPost] as const;
