import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error, problemFields } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1308 (plan M10.5; D-271 MQ02): the HTTP layer over the student data
// export of SRV-1307 (migration 20261210100000). A clerk of the registry
// office (app.registry_clerk) requests the export of a student or a former
// student of the institution and confirms the identity check; a confirmed
// administrator who did not request approves with the job reference; the
// worker prepares the package and a one-time link valid for 24 hours. Who may
// do what is the decision of the database; the caller comes only from the
// session. The access value names the closest declared one: the registry
// office has no access value of its own, so the request and the list are
// "signed_in" and the database refuses everyone but a clerk or an
// administrator (403).

/** Lowercase UUID, as PostgreSQL writes uuid. */
const ExportId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Any-case UUID of the path; the handler lower-cases it. */
const ExportIdParam = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const State = Type.Union([
  Type.Literal("requested"),
  Type.Literal("approved"),
  Type.Literal("ready"),
  Type.Literal("downloaded"),
  Type.Literal("expired"),
]);
/** How the clerk checked the identity of the person in front of them; never a document number. */
export const IDENTITY_CHECKS = ["identity_card", "passport", "student_card"] as const;
const IdentityCheckedBy = Type.Union(IDENTITY_CHECKS.map((value) => Type.Literal(value)));
/** The reference of the check (e.g. the registry's case number): 1 to 80 characters. */
const Note = Type.String({ minLength: 1, maxLength: 80 });
/** app.student_data_export.job_ref: 1 to 120 characters. */
const Reference = Type.String({ minLength: 1, maxLength: 120 });
/** The link token: 32 random bytes in base64url. */
const LinkToken = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });

const REFUSALS = [
  error(422, "invalid_input"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(409, "conflict"),
  error(503, "unavailable"),
] as const;

// SRV-ADMIN-3 (NF-7 OA-6): the reason of the request's 409, sent on every such
// answer. The database refuses a second open request (requested, approved or
// ready) for the same person; the text behind reasonKey is in the server's
// catalogue (locales, adminSettings). Optional in v1: a new response field.
export const EXPORT_ALREADY_OPEN = "export_already_open";
export const EXPORT_ALREADY_OPEN_KEY = "adminSettings.exportAlreadyOpen";
const OpenRequestConflict = closed({
  error: Type.Literal("conflict"),
  ...problemFields("conflict", 409),
  reason: Type.Optional(
    Type.Literal(EXPORT_ALREADY_OPEN, {
      description:
        "An open request (requested, approved or ready) for the same person already exists; sent on every 409 of the request.",
    }),
  ),
  reasonKey: Type.Optional(
    Type.Literal(EXPORT_ALREADY_OPEN_KEY, {
      description: "The key of the reason's text in the server's catalogue (locales).",
    }),
  ),
});
const REQUEST_REFUSALS = [
  error(422, "invalid_input"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(409, "conflict", OpenRequestConflict),
  error(503, "unavailable"),
] as const;

export const studentDataExportsPost = defineRoute({
  id: "institution.student-data-exports.post",
  method: "POST",
  path: "/api/v1/institution/student-data-exports",
  inventory: "app/api/institution/student-data-exports/route.ts",
  access: "signed_in",
  summary:
    "A clerk of the registry office requests the export of the data of a student or a former student of the institution and confirms that the identity was checked: exactly {studentId, identityCheckedBy, note}, identityCheckedBy one of identity_card, passport, student_card, note the reference of the check (1 to 80 characters, never a document number), at most 2 KiB, as application/json. A caller who is not a clerk, a clerk who is also an administrator, and a clerk for themselves are 403; a person outside the institution is 404; an open request for the person is 409; an invalid note is 422.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 2048,
    body: closed({ studentId: ExportId, identityCheckedBy: IdentityCheckedBy, note: Note }),
  },
  responses: [
    {
      status: 201,
      description: "the request is recorded",
      body: closed({ exportId: ExportId }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    ...REQUEST_REFUSALS,
  ],
});

export const studentDataExportsApprovePost = defineRoute({
  id: "institution.student-data-exports-approve.post",
  method: "POST",
  path: "/api/v1/institution/student-data-exports/{exportId}/approve",
  inventory: "app/api/institution/student-data-exports/[exportId]/approve/route.ts",
  access: "institution_admin",
  summary:
    "A confirmed administrator of the institution, who is neither the clerk who requested nor the person, starts the job with its reference: exactly {reference}, 1 to 120 characters, at most 2 KiB, as application/json. Anyone else is 403; a request of another institution, or an id that is not a UUID, is 404; a request no longer waiting is 409; an invalid reference is 422.",
  request: {
    params: closed({ exportId: ExportIdParam }),
    contentType: "application/json",
    maxBodyBytes: 2048,
    body: closed({ reference: Reference }),
  },
  responses: [
    {
      status: 200,
      description: "the job is approved; the worker prepares the package",
      body: closed({ exportId: ExportId, state: Type.Literal("approved") }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    ...REFUSALS,
  ],
});

export const studentDataExportsGet = defineRoute({
  id: "institution.student-data-exports.get",
  method: "GET",
  path: "/api/v1/institution/student-data-exports",
  inventory: "app/api/institution/student-data-exports/route.ts",
  access: "signed_in",
  summary:
    "The data exports the caller may see, newest first: every request of the institution for a clerk of the registry office or an administrator, the caller's own for anyone else, never another institution's. The link token is never returned; expiresAt is null until the package is ready.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the exports, possibly none",
      body: closed({
        exports: Type.Array(
          closed({
            exportId: ExportId,
            state: State,
            requestedAt: Instant,
            expiresAt: Type.Union([Instant, Type.Null()]),
          }),
        ),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

// SRV-NF7-IZVOZ-STUDENT (NF-7 OA-6): who each request is for, beside the list,
// so the registry office sees that a person already has an open request
// before asking again. A new route rather than a field of the list: a new
// field in an existing body is a major release (scripts/release/README.md,
// QA #92). The same reach as the list, read from the same function; nothing
// but the person and the state.
export const studentDataExportStudentsGet = defineRoute({
  id: "institution.student-data-export-students.get",
  method: "GET",
  path: "/api/v1/institution/student-data-export-students",
  inventory: "app/api/institution/student-data-export-students/route.ts",
  access: "signed_in",
  summary:
    "For each data export the caller may see, the person it is for and its state, newest first: every request of the institution for a clerk of the registry office or an administrator, the caller's own for anyone else, never another institution's (someone else's request is absent, as one that does not exist). Only exportId, studentId and state.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the person and state of each export, possibly none",
      body: closed({
        exports: Type.Array(closed({ exportId: ExportId, studentId: ExportId, state: State })),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const studentDataExportGet = defineRoute({
  id: "student.data-export.get",
  method: "GET",
  path: "/api/v1/student/data-export/{token}",
  inventory: "app/api/student/data-export/[token]/route.ts",
  access: "anyone",
  summary:
    "Download of a ready student data export through its one-time link, without a session (a former student may have none): application/zip (izvoz-mojih-podataka.zip) the first time within 24 hours of the package being ready, as an attachment; the same contents give the same bytes and X-Content-SHA256 is the SHA-256 of the body. The ZIP holds manifest.json, the submitted texts and receipt PDFs under predaje/, biljeske.json and dnevnik-pristupa.json. A used, expired or unknown link is 410, as a problem.",
  request: {
    params: closed({ token: LinkToken }),
  },
  responses: [
    {
      status: 200,
      description: "ZIP bytes; the contract format has no binary body",
      headers: ["content-disposition", "cache-control", "x-content-sha256"],
    },
  ],
  errors: [error(410, "not_allowed"), error(503, "unavailable")],
});

export const studentDataExportRoutes = [
  studentDataExportsGet,
  studentDataExportStudentsGet,
  studentDataExportsPost,
  studentDataExportsApprovePost,
  studentDataExportGet,
] as const;
