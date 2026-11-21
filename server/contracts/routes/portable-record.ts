import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-1312 (plan M7.10; D-49, A-07, D-173, D-263 Q24): the portable record
// of one submission, for the student who submitted it. A deterministic ZIP
// (stored entries, fixed time and order: the same submission gives the same
// bytes) of the signed receipt V2, its key, the exact submitted text, the
// receipt PDF whose QR carries only the submission id and the SHA-256 of the
// text in the URL fragment, and, once the day is closed, the signed daily
// root with the Merkle proof of the receipt's entry (SRV-1311), all named in
// manifest.json with their SHA-256. It is checked offline with
// scripts/evidence-verify --record or through the existing public check of
// the receipt; there is no new public route with data.

const SubmissionId = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

export const studentPortableRecordGet = defineRoute({
  id: "student.portable-record.get",
  method: "GET",
  path: "/api/v1/student/submissions/{submissionId}/portable-record",
  inventory: "app/api/student/submissions/[submissionId]/portable-record/route.ts",
  access: "student_owner",
  summary:
    "Download the portable record of the caller's own submission as application/zip (prenosivi-zapis.zip). The ZIP holds manifest.json (format ductura.portable-record.v1: the submission id, dailyRoot included or pending, and every other file with its size and SHA-256), potvrda.json (the signed submission receipt V2), kljuc-potvrde.json (its public key and validity), rad.json (the exact submitted text, whose SHA-256 is the receipt's artifactSha256), potvrda-predaje.pdf (the receipt PDF; its QR carries only the submission id and that SHA-256, in the URL fragment) and, once the day of signing is closed, dnevni-korijen.json, kljuc-dnevnog-korijena.pem and merkle-dokaz.json (the signed daily root and the inclusion proof of the receipt's entry). The same submission gives the same bytes; X-Content-SHA256 is the SHA-256 of the ZIP. Another's, an unknown or a malformed submission, and one without a signed receipt, return 404.",
  request: { params: closed({ submissionId: SubmissionId }) },
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
    error(503, "unavailable"),
  ],
});

export const portableRecordRoutes = [studentPortableRecordGet] as const;
