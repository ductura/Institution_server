import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const UUID = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

const RECEIPT_PDF = {
  status: 200,
  description: "PDF bytes encoded in standard Base64, with a download filename",
  headers: ["cache-control"],
  body: closed({
    filename: Type.Literal("potvrda-predaje.pdf"),
    pdfBase64: Type.String({ minLength: 8, pattern: "^JVBERi0[A-Za-z0-9+/]*={0,2}$" }),
  }),
} as const;

const ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const receiptPdfRoutes = [
  defineRoute({
    id: "student.receipt-pdf.get",
    method: "GET",
    path: "/api/v1/student/assignments/{assignmentId}/submission/pdf",
    inventory: "app/api/student/assignments/[assignmentId]/submission/pdf/route.ts",
    access: "student_enrolled",
    summary:
      "Download the caller's signed submission receipt as a PDF. No signed receipt, an inaccessible assignment or a malformed id returns 404.",
    request: { params: closed({ assignmentId: UUID }) },
    responses: [RECEIPT_PDF],
    errors: ERRORS,
  }),
  defineRoute({
    id: "teacher.receipt-pdf.get",
    method: "GET",
    path: "/api/v1/teacher/assignments/{assignmentId}/submissions/{studentId}/pdf",
    inventory: "app/api/teacher/assignments/[assignmentId]/submissions/[studentId]/pdf/route.ts",
    access: "teacher",
    summary:
      "Download the same PDF as the student, for a reader authorized to see this submission. No signed receipt, no relation to the work or a malformed id returns 404.",
    request: { params: closed({ assignmentId: UUID, studentId: UUID }) },
    responses: [RECEIPT_PDF],
    errors: ERRORS,
  }),
] as const;
