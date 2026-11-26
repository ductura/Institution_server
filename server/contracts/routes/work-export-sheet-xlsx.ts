import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-V14-SHEET-XLSX (val 14 decision 6, Ductus#2058): the .xlsx of one saved
// version of a spreadsheet work, for its owner and the teacher of its assignment
// (the readers of work.export.get). The workbook is written from the stored
// SheetDocument of that version with every formula computed again by the
// server (a stored result is never the truth), so the same version gives the
// same bytes and the same X-Export-Sheet-Sha256. The version is named by its
// revision, as work.versions.get lists it; without versionId the newest saved
// version is exported. Another's, an unknown or a malformed work, an unknown
// version and a work that is not a spreadsheet are the same 404 (C-23).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as work-export-docx.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});

export const workExportSheetXlsxGet = defineRoute({
  id: "work.export-sheet-xlsx.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/export/xlsx",
  inventory: "app/api/works/[documentId]/export/xlsx/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Download one saved version of a spreadsheet work as an .xlsx (OOXML, no macros): every sheet, the text and number of each cell, and each formula with the value the server computed again (an error is its code, such as #DIV/0!). The same version gives the same bytes and the same X-Export-Sheet-Sha256 (the SHA-256 of the canonical sheet document, lowercase hex). versionId is a revision from work.versions.get; without it the newest saved version is exported. A teacher's read writes the access log, as the versions list does. Another's, an unknown or a malformed work, an unknown version and a work that is not a spreadsheet return 404.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      versionId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the .xlsx bytes of the version",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: ["x-export-sheet-sha256"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workExportSheetXlsxRoutes = [workExportSheetXlsxGet] as const;
