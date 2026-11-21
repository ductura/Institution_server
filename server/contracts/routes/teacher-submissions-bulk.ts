import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1902 (plan P-D2, owner's decision of 21. 11. 2026): the teacher of an
// assignment downloads every submission of it as one ZIP: the submitted work
// of each student as PDF or DOCX (one format per download) and the PDF of its
// signed receipt. The teacher asks for a link (POST) and downloads through it
// (GET) within its 24 hours. The access is the one of a single submission:
// only the teacher of the assignment (another's, an unknown and a malformed
// assignment are the same 404, C-23), and the read of every submitted text
// writes the teacher's opening to the access log (SRV-11) on every download.
// The link carries its expiry under the issuing session's key, as the
// submission package of SRV-1807; it is not a bearer capability.

const AssignmentId = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const Format = Type.Union([Type.Literal("pdf"), Type.Literal("docx")]);
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/submissions-bulk";

export const teacherSubmissionsBulkLinkPost = defineRoute({
  id: "teacher.submissions-bulk-link.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/submissions-bulk-link",
  inventory: "app/api/teacher/assignments/[assignmentId]/submissions-bulk-link/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment asks for a link to the ZIP of all its submissions, with the works as PDF (format pdf) or DOCX (format docx). The answer is the download path with the link token and its expiry, 24 hours after the request; asking again issues a new link and changes nothing stored. The request reads no work and writes nothing. Another's, an unknown or a malformed assignment returns 404.",
  request: {
    params: closed({ assignmentId: AssignmentId }),
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ format: Format }),
  },
  responses: [
    {
      status: 201,
      description: "the link",
      body: closed({
        format: Format,
        downloadPath: Type.String({
          pattern:
            "^/api/v1/teacher/assignments/[0-9a-f-]{36}/submissions-bulk/(pdf|docx)\\?token=\\d{1,15}\\.[A-Za-z0-9_-]{43}$",
        }),
        expiresAt: Instant,
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
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const teacherSubmissionsBulkGet = defineRoute({
  id: "teacher.submissions-bulk.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/submissions-bulk/{format}",
  inventory: `${INVENTORY}/[format]/route.ts`,
  access: "course_teacher",
  summary:
    "Download through a link from teacher.submissions-bulk-link.post, within its 24 hours and with the session that asked for it, while the caller teaches the assignment. The body is application/zip (predaje.zip): for every submitted work of this assignment and no other, the work as <name>.pdf or <name>.docx and its signed receipt as <name>-potvrda.pdf (absent while the receipt awaits its signature), and otisci.sha256 with the SHA-256 of every file. Every download writes the opening of each submitted text to the access log. X-Content-SHA256 is the SHA-256 of the body. A link of another assignment, format or session, or an assignment the caller does not teach, is 404, an expired link 410, a cross-site read 403.",
  request: {
    params: closed({ assignmentId: AssignmentId, format: Format }),
    query: closed({ token: Type.String({ pattern: "^\\d{1,15}\\.[A-Za-z0-9_-]{43}$" }) }),
  },
  responses: [
    {
      status: 200,
      description: "ZIP bytes (application/zip); the contract format has no binary body",
      headers: ["content-disposition", "cache-control", "x-content-sha256"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(410, "not_allowed"),
    error(503, "unavailable"),
  ],
});

export const teacherSubmissionsBulkRoutes = [
  teacherSubmissionsBulkLinkPost,
  teacherSubmissionsBulkGet,
] as const;
