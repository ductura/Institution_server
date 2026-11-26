import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-V13-RUTA-IZVOZ (val 13, Ductus#2058 c.7183811220): the .pptx or the PDF
// of one saved version of a slides work, for its owner and the teacher of its
// assignment (the readers of work.export.get). The .pptx is written from the
// frozen snapshot of that version (SRV-V13-IZVOZ-PPTX), so the same version
// gives the same .pptx bytes and the same X-Export-Snapshot-Sha256; the PDF is
// made from exactly that .pptx by the local converter, with no new network
// dependency, and carries the same snapshot hash. The version is named by its
// revision, as work.versions.get lists it; without versionId the newest saved
// version is exported. Another's, an unknown or a malformed work, an unknown
// version and a work that is not a slides work are the same 404 (C-23). A
// format outside pptx|pdf is 422. Nothing here widens work.export.get.

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as work-export-docx.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});

export const workExportSlidesGet = defineRoute({
  id: "work.export-slides.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/export-slides",
  inventory: "app/api/works/[documentId]/export-slides/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Download one saved version of a slides work as a .pptx or a PDF. The .pptx is written from the frozen snapshot of the version: the same version gives the same bytes and the same X-Export-Snapshot-Sha256 (the SHA-256 of the snapshot, lowercase hex). The PDF is converted from that .pptx by the local converter and carries the same snapshot hash, but its own bytes are not promised to be identical between requests; it is never marked PDF/A. format is pptx or pdf. versionId is a revision from work.versions.get; without it the newest saved version is exported. A teacher's read writes the access log, as the versions list does. Another's, an unknown or a malformed work, an unknown version and a work that is not a slides work return 404; a format outside the list returns 422; a conversion that is not available, times out or fails, and an image the version binds that cannot be printed, return 503.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      format: Type.Union([Type.Literal("pptx"), Type.Literal("pdf")]),
      versionId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the .pptx or the PDF bytes of the version",
      contentType: [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/pdf",
      ],
      headers: ["x-export-snapshot-sha256", "content-disposition"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workExportSlidesRoutes = [workExportSlidesGet] as const;
