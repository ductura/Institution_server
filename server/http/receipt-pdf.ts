import { receiptPdfHr } from "../../locales/index.ts";
import { ROUTES } from "../contracts/index.ts";
import { renderReceiptPdf } from "../downloads/index.ts";
import {
  createMySubmissionConfirmationCodeReader,
  createMySubmissionStateReader,
  type MySubmissionConfirmationCodeReader,
} from "../database/index.ts";
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
import { showsReceiptOf } from "./submission-confirmation-code.ts";

type ReadReceipt = (
  token: string,
  assignmentId: string,
  studentId?: string,
) => Promise<StudentSubmissionAnswer>;

/** Dizajn 1.1: the bound confirmation code of the same submission, null before it. */
type ReadCode = (
  token: string,
  assignmentId: string,
  studentId?: string,
) => ReturnType<MySubmissionConfirmationCodeReader["read"]>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBLEMS = { 401: "unauthorized", 404: "not_found", 503: "unavailable" } as const;

export function createReceiptPdfRoutes(
  read: ReadReceipt,
  readCode: ReadCode,
  origin: string | null,
): Route[] {
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
          // The code is read after the receipt, under the same session; a failed
          // read is 503, never a PDF quietly without the code it should carry.
          const code = await readCode(token, assignmentId, studentId);
          if (!code.ok) {
            reportServerError("route", new Error(code.error.code), requestIdOf(response), id);
            return sendProblem(response, 503, "unavailable");
          }
          // The code is of the submission live at its read, not of this
          // receipt's: only a receipt read again after it as the same
          // submission's vouches for it. A withdrawal or a new submission in
          // between is a passing race, 503, never this PDF with another's code.
          const again = await read(token, assignmentId, studentId);
          if (!showsReceiptOf(again, receipt.payload.submissionId)) {
            reportServerError("route", new Error("receipt_changed"), requestIdOf(response), id);
            return sendProblem(response, 503, "unavailable");
          }
          const pdf = await renderReceiptPdf(receipt, origin, receiptPdfHr, code.value);
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
 * as student.submission.get and teacher.submission-receipt.get, and the code
 * through the reader of the two confirmation-code routes.
 */
export function createReceiptPdfRoutesFor(
  main: Pick<Databases["main"], "withActor">,
  origin: string | null,
): Route[] {
  const reader = createMySubmissionStateReader(main.withActor);
  const codes = createMySubmissionConfirmationCodeReader(main.withActor);
  return createReceiptPdfRoutes(
    (token, assignmentId, studentId) =>
      studentId === undefined
        ? readStudentSubmission(reader, token, assignmentId)
        : readTeacherSubmission(reader, token, assignmentId, studentId),
    (token, assignmentId, studentId) =>
      studentId === undefined
        ? codes.read(token, assignmentId)
        : codes.teacherRead(token, assignmentId, studentId),
    origin,
  );
}
