import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { CODE_POINT, END } from "./teacher.ts";

// SRV-1531 (Ductus#2052; N-14): the interview preparation as a PDF. It holds
// exactly what the student reads once the invitation is sent, and nothing else.
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});

export const workInterviewPdfRoutes = [
  defineRoute({
    id: "work.interview-pdf.get",
    method: "GET",
    path: "/api/v1/works/{documentId}/interview/pdf",
    inventory: "app/api/works/[documentId]/interview/pdf/route.ts",
    access: "owner_or_course_teacher",
    summary:
      "The PDF of the interview preparation of an accessible work: the same questions, explanations, appointment and date the student reads, under the notice that the preparation is no accusation and no disciplinary proceeding. Before the invitation there is nothing the student reads, so it is 409. Anyone who may not read the preparation gets 403.",
    request: { params: closed({ documentId: DocumentId }) },
    responses: [
      {
        status: 200,
        description: "PDF bytes encoded in standard Base64, with a download filename",
        headers: ["cache-control"],
        body: closed({
          filename: Type.Literal("priprema-za-razgovor.pdf"),
          pdfBase64: Type.String({ minLength: 8, pattern: "^JVBERi0[A-Za-z0-9+/]*={0,2}$" }),
        }),
      },
    ],
    errors: [
      error(401, "unauthorized"),
      error(403, "forbidden"),
      error(404, "not_found"),
      error(409, "conflict"),
      error(503, "unavailable"),
    ],
  }),
] as const;
