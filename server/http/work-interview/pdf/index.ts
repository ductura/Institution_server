// GET /api/v1/works/{documentId}/interview/pdf (work.interview-pdf.get, SRV-1531):
// the interview preparation of a work as a PDF. The preparation is read through
// the same database port as work.interview.get, so the reader sees what that
// route lets them see (C-23), and the PDF holds exactly what the student reads
// once the invitation is sent. Before it, nothing is shared yet: 409.
import { interviewPdfHr } from "../../../../locales/index.ts";
import { ROUTES, workIdFromPath } from "../../../contracts/index.ts";
import { createWorkInterviewStore, type WithActor } from "../../../database/index.ts";
import { renderInterviewPdf } from "../../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.interview-pdf.get");
  if (found === undefined) throw new Error("no contract work.interview-pdf.get");
  return found;
})();
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
]);

export function createWorkInterviewPdfRouteFor({ withActor }: { withActor: WithActor }): Route {
  const store = createWorkInterviewStore(withActor);
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return sendProblem(response, 404, "not_found");
      try {
        const interview = await store.get(token, documentId);
        if (interview.invitedAt === null) return sendProblem(response, 409, "conflict");
        const pdf = await renderInterviewPdf(
          { ...interview, documentId, invitedAt: interview.invitedAt },
          interviewPdfHr,
        );
        return sendJson(response, 200, {
          filename: "priprema-za-razgovor.pdf",
          pdfBase64: Buffer.from(pdf).toString("base64"),
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}
