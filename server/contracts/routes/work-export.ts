import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const Hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const output = {
  filename: Type.Literal("rad.pdf"),
  pdfBase64: Type.String({ pattern: "^JVBERi0[A-Za-z0-9+/]*={0,2}$" }),
  outputSha256: Hash,
};

export const workExportRoutes = [
  defineRoute({
    id: "work.export-pdf.get",
    method: "GET",
    path: "/api/v1/assignments/{assignmentId}/works/{documentId}/export/pdf",
    inventory: "app/api/assignments/[assignmentId]/works/[documentId]/export/pdf/route.ts",
    access: "signed_in",
    summary:
      "Download the submitted or last saved revision as the owner or supervising teacher. The report hash is present only for certified bytes.",
    request: {
      params: closed({
        assignmentId: Type.String({
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
        documentId: Type.String({ minLength: 1, maxLength: 512 }),
      }),
    },
    responses: [
      {
        status: 200,
        description: "Generated work export",
        headers: ["cache-control"],
        body: Type.Union([
          closed({
            ...output,
            format: Type.Literal("pdf"),
            reportHash: Type.Null(),
            docxBase64: Type.String({ pattern: "^UEsD[A-Za-z0-9+/]*={0,2}$" }),
            noticeKey: Type.Literal("workExport.plainPdf"),
          }),
          closed({ ...output, format: Type.Literal("pdfa-2u"), reportHash: Hash }),
        ]),
      },
    ],
    errors: [
      error(401, "unauthorized"),
      error(403, "forbidden"),
      error(404, "not_found"),
      error(503, "unavailable"),
    ],
  }),
] as const;
