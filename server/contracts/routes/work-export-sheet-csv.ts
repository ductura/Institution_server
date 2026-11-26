import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-V14-SHEET-CSV (val 14, docs/nalazi/val14-razlika.md decision 6): the CSV
// of one sheet of a work of kind spreadsheet, for its owner and the teacher of
// its assignment (the readers of work.export.get). UTF-8 with a byte order
// mark, `;` between cells, CRLF line ends, the computed value of every cell
// (the server computes the formulas again, decision 4); a text that starts
// with = + - @ a tab or a carriage return gets a leading apostrophe. The
// newest saved version is exported; sheet names one sheet by its id, without
// it the first sheet. Another's, an unknown or a malformed work, a work that
// is not a spreadsheet and an unknown sheet are the same 404 (C-23).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});

export const workExportSheetCsvGet = defineRoute({
  id: "work.export-sheet-csv.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/export/csv",
  inventory: "app/api/works/[documentId]/export/csv/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Download one sheet of a spreadsheet work as CSV: UTF-8 with a byte order mark, semicolon between cells, CRLF line ends, the computed value of every cell (formulas are computed again on the server). A text that starts with = + - @ a tab or a carriage return gets a leading apostrophe. sheet is the id of a sheet of the work; without it the first sheet is exported. A teacher's read writes the access log, as work.export.get does. Another's, an unknown or a malformed work, a work that is not a spreadsheet and an unknown sheet return 404.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      sheet: Type.Optional(
        Type.String({
          pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        }),
      ),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the CSV bytes of the sheet",
      contentType: "text/csv",
      headers: ["content-disposition"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workExportSheetCsvRoutes = [workExportSheetCsvGet] as const;
