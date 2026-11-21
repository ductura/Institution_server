import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1807 (plan M8.6, R-05, R-06, D-173): the export package of a submission
// and the confirmation for the registrar, for the student who submitted. The
// student asks for a link (POST) and downloads through it (GET) for 24 hours.
//   package   the portable record of SRV-1312: one ZIP whose manifest.json is
//             the single manifest of D-173; the unpacked folder is checked
//             offline by scripts/evidence-verify --record (SRV-1311)
//   referada  the receipt PDF alone: no text of the work in it (R-06)
// Both come from one checked build over the stored values of the submission;
// nothing is generated anew per download. The link carries its 24 hour expiry
// under the issuing session's key; the download still needs that live session
// and the caller's own submission (another's, an unknown, a malformed one and
// one without a signed receipt are the same 404, C-23). A link that outlives
// the session, for the registrar (D-271 MQ02), needs stored state: M10.5.

const SubmissionId = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const Kind = Type.Union([Type.Literal("package"), Type.Literal("referada")]);
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const INVENTORY = "app/api/student/submissions/[submissionId]";

export const studentSubmissionPackageLinkPost = defineRoute({
  id: "student.submission-package-link.post",
  method: "POST",
  path: "/api/v1/student/submissions/{submissionId}/package-link",
  inventory: `${INVENTORY}/package-link/route.ts`,
  access: "student_owner",
  summary:
    "Ask for a link to the export package (kind package) or to the confirmation for the registrar (kind referada) of the caller's own submission. The answer is the download path with the link token and its expiry, 24 hours after the request; asking again issues a new link and changes nothing stored. Another's, an unknown or a malformed submission returns 404.",
  request: {
    params: closed({ submissionId: SubmissionId }),
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ kind: Kind }),
  },
  responses: [
    {
      status: 201,
      description: "the link",
      body: closed({
        kind: Kind,
        downloadPath: Type.String({
          pattern:
            "^/api/v1/student/submissions/[0-9a-f-]{36}/package/(package|referada)\\?token=\\d{1,15}\\.[A-Za-z0-9_-]{43}$",
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

export const studentSubmissionPackageGet = defineRoute({
  id: "student.submission-package.get",
  method: "GET",
  path: "/api/v1/student/submissions/{submissionId}/package/{kind}",
  inventory: `${INVENTORY}/package/[kind]/route.ts`,
  access: "student_owner",
  summary:
    "Download through a link from student.submission-package-link.post, within its 24 hours and with the session that asked for it. Kind package is application/zip (prenosivi-zapis.zip, the portable record: manifest.json is the single D-173 manifest); kind referada is application/pdf (the receipt PDF without the text of the work, as an attachment). The same submission gives the same bytes; X-Content-SHA256 is the SHA-256 of the body. A link of another submission, kind or session is 404, an expired link 410, a cross-site read 403.",
  request: {
    params: closed({ submissionId: SubmissionId, kind: Kind }),
    query: closed({ token: Type.String({ pattern: "^\\d{1,15}\\.[A-Za-z0-9_-]{43}$" }) }),
  },
  responses: [
    {
      status: 200,
      description: "ZIP or PDF bytes; the contract format has no binary body",
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

export const submissionPackageRoutes = [
  studentSubmissionPackageLinkPost,
  studentSubmissionPackageGet,
] as const;
