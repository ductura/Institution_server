import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-1310 (plan M8.4, Ductus#2052): the DOCX of one saved version of a work,
// for its owner and the teacher of its assignment (the reader of work.versions.get).
// The bytes are rendered from the frozen export snapshot of that version
// (server/domain/export-snapshot, SRV-1309), so the same version gives the same
// bytes and the same X-Export-Snapshot-Sha256 on every request. The version is
// named by its revision, as work.versions.get lists it; without versionId the
// newest saved version is exported. Another's, an unknown or a malformed work,
// and an unknown version, are the same 404 as for the versions list (C-23).
// PDF is not ready: format=pdf is a 422 problem until it is.

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});

export const workExportGet = defineRoute({
  id: "work.export.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/export",
  inventory: "app/api/works/[documentId]/export/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Download one saved version of a work as a DOCX, rendered from its frozen export snapshot: the same version gives the same bytes and the same X-Export-Snapshot-Sha256 (the SHA-256 of the snapshot, lowercase hex). format is docx; pdf is not ready and returns 422. versionId is a revision from work.versions.get; without it the newest saved version is exported. A teacher's read writes the access log, as the versions list does. Another's, an unknown or a malformed work, and an unknown version, return 404.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      format: Type.Union([Type.Literal("docx"), Type.Literal("pdf")]),
      versionId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the DOCX bytes of the version",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      headers: ["x-export-snapshot-sha256"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workExportDocxRoutes = [workExportGet] as const;
