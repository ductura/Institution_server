import { receiptPdfHr } from "../../locales/index.ts";
import { ROUTES } from "../contracts/index.ts";
import { renderReceiptPdf } from "../downloads/index.ts";
import { createMySubmissionStateReader } from "../database/index.ts";
import {
  readStudentSubmission,
  readTeacherSubmission,
  type StudentSubmissionAnswer,
} from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

type ReadReceipt = (
  token: string,
  assignmentId: string,
  studentId?: string,
) => Promise<StudentSubmissionAnswer>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBLEMS = { 401: "unauthorized", 404: "not_found", 503: "unavailable" } as const;

export function createReceiptPdfRoutes(read: ReadReceipt, origin: string | null): Route[] {
  return (["student.receipt-pdf.get", "teacher.receipt-pdf.get"] as const).map((id) => {
    const contract = ROUTES.find((route) => route.id === id);
    if (contract === undefined) throw new Error(`no contract ${id}`);
    return {
      contract,
      async handle(request, response, params) {
        const site = request.headersDistinct["sec-fetch-site"];
        if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
          return sendProblem(response, 403, "forbidden");
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = params?.assignmentId?.toLowerCase() ?? "";
        const studentId = params?.studentId?.toLowerCase();
        if (
          !UUID.test(assignmentId) ||
          (id === "teacher.receipt-pdf.get" && !UUID.test(studentId ?? ""))
        ) {
          return sendProblem(response, 404, "not_found");
        }
        if (origin === null) return sendProblem(response, 503, "unavailable");
        try {
          const result = await read(token, assignmentId, studentId);
          if (result.status !== 200) {
            return sendProblem(response, result.status, PROBLEMS[result.status]);
          }
          if (result.body.state !== "potvrdeno") return sendProblem(response, 404, "not_found");
          const { receipt } = result.body;
          if (studentId !== undefined && receipt.payload.principalId !== studentId) {
            return sendProblem(response, 503, "unavailable");
          }
          const pdf = await renderReceiptPdf(receipt, origin, receiptPdfHr);
          return sendJson(response, 200, {
            filename: "potvrda-predaje.pdf",
            pdfBase64: Buffer.from(pdf).toString("base64"),
          });
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    };
  });
}

/**
 * The two PDF routes over main's application withActor (INT-31): the student
 * reads their own receipt, the teacher one student's, through the same reader
 * as student.submission.get and teacher.submission-receipt.get.
 */
export function createReceiptPdfRoutesFor(
  main: Pick<Databases["main"], "withActor">,
  origin: string | null,
): Route[] {
  const reader = createMySubmissionStateReader(main.withActor);
  return createReceiptPdfRoutes(
    (token, assignmentId, studentId) =>
      studentId === undefined
        ? readStudentSubmission(reader, token, assignmentId)
        : readTeacherSubmission(reader, token, assignmentId, studentId),
    origin,
  );
}
