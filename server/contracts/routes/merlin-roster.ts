import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { DEADLINE_EXTENSION_REASONS } from "./deadline-extensions.ts";
import { Name } from "./teacher.ts";

// SRV-1109 (Ductus#2051 c.7048729191, Val 11, N-18, C-16, D-286): the roster
// of an assignment for Merlin, for its teacher. One row per student by
// surname (Croatian alphabet), with the columns of D-286 and the names and
// SHA-256 fingerprints of the student's PDF and DOCX in the package, rendered
// from the submitted revision. A student without a submission has null file
// names and fingerprints. Nothing from the process summary, no private
// criterion. The extension reasons (SRV-1108) leave only in the JSON answer,
// only on the records the caller wrote (N-13). The CSV route answers the same
// rows and columns as text/csv; the contract format has no text body, so its
// success declares the headers only (open item for the contract format).
// Reads app.fast_path_works, which writes the teacher's opening of every text
// to the access log.

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const FileName = (extension: string) =>
  Type.String({
    pattern: `^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}(?:[0-9a-f]{24})?\\.${extension}$`,
  });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const NAMES = [
  { familyName: Name, givenName: Name },
  { familyName: Type.Null(), givenName: Type.Null() },
] as const;
const STATES = [
  {
    submitted: Type.Literal(false),
    submittedMinute: Type.Null(),
    afterDeadline: Type.Null(),
    pdfName: Type.Null(),
    pdfSha256: Type.Null(),
    docxName: Type.Null(),
    docxSha256: Type.Null(),
  },
  {
    submitted: Type.Literal(true),
    submittedMinute: Minute,
    afterDeadline: Type.Boolean(),
    pdfName: FileName("pdf"),
    pdfSha256: Sha256,
    docxName: FileName("docx"),
    docxSha256: Sha256,
  },
] as const;
const RosterRow = Type.Union(
  NAMES.flatMap((names) => STATES.map((state) => closed({ ...names, ...state }))),
);
const ExtensionReason = closed({
  studentId: Type.Union([Uuid, Type.Null()]),
  dueAt: Instant,
  reasonId: literals(DEADLINE_EXTENSION_REASONS),
});

const params = closed({ assignmentId: Type.String({ minLength: 1 }) });
const ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/merlin";

export const teacherMerlinRosterGet = defineRoute({
  id: "teacher.merlin-roster.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/merlin/roster",
  inventory: `${INVENTORY}/roster/route.ts`,
  access: "course_teacher",
  summary:
    "The Merlin roster of an assignment for its teacher (D-286): one row per student by surname (Croatian alphabet), then given name; a student without a name pair last. Columns: surname, given name, submitted, the submission minute, after the deadline (with an approved extension, as the submission recorded it), and the names and SHA-256 fingerprints of the PDF and DOCX of the submitted revision in the package; null for a student without a submission. extensionReasons are the caller's own deadline extension records (N-13), oldest first. Nothing from the process summary and no private criterion. The read writes the teacher's opening of each work to the access log. A cross-site read is 403; an inaccessible, unknown or malformed assignment 404; reads that disagree 503.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "the roster, possibly with no rows",
      body: closed({
        rows: Type.Array(RosterRow),
        extensionReasons: Type.Array(ExtensionReason),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: ERRORS,
});

export const teacherMerlinRosterCsvGet = defineRoute({
  id: "teacher.merlin-roster-csv.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/merlin/csv",
  inventory: `${INVENTORY}/csv/route.ts`,
  access: "course_teacher",
  summary:
    "The rows of teacher.merlin-roster.get as text/csv; charset=utf-8 (RFC 4180, CRLF, UTF-8 byte order mark): a header from the message catalogue (locales/merlin.ts) and the same columns in the same order. A null is an empty cell, true and false are the catalogue's yes and no words; a cell a spreadsheet would read as a formula starts with an apostrophe. No extension reasons. Content-Disposition names the file merlin-popis.csv. Errors as teacher.merlin-roster.get, as JSON.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "CSV bytes (text/csv; charset=utf-8); the contract format has no text body",
      headers: ["content-disposition", "cache-control"],
    },
  ],
  errors: ERRORS,
});

export const merlinRosterRoutes = [teacherMerlinRosterGet, teacherMerlinRosterCsvGet] as const;
