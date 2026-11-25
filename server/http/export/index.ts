import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createSnapshotPdf,
  freezePdfSource,
  localPdfConverter,
  type ConvertDocx,
} from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { sendJson, sendProblem, type Databases, type Route } from "../index.ts";
import { MERLIN_LABELS } from "../merlin-roster/index.ts";
import { readPdfSource, type ReadPdfSource } from "./read-source.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DAY_MS = 24 * 60 * 60 * 1_000;
const PROBLEMS = new Map<string, number>([
  ["unauthorized", 401],
  ["not_found", 404],
  ["unavailable", 503],
]);

export function createWorkPdfRoute(read: ReadPdfSource, convert: ConvertDocx | undefined): Route {
  const contract = ROUTES.find((route) => route.id === "work.export-pdf.get");
  if (contract === undefined) throw new Error("Missing work.export-pdf.get contract");
  let rendering = false;
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignment = params?.assignmentId ?? "";
      const document = workIdFromPath(params?.documentId ?? "");
      if (!UUID.test(assignment) || document === null)
        return sendProblem(response, 404, "not_found");
      const source = await read(token, assignment, document);
      if (source.status !== "found")
        return sendProblem(response, PROBLEMS.get(source.status) ?? 503, source.status);
      if (convert === undefined || rendering) return sendProblem(response, 503, "unavailable");
      rendering = true;
      try {
        const snapshot = await freezePdfSource({
          ...source,
          expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
          cover: {
            institution: source.institution,
            unit: "",
            workType: source.title,
            student: source.student,
            mentor: "",
          },
        });
        if (snapshot === null) return sendProblem(response, 503, "unavailable");
        const { pdf, docx, format, outputSha256, reportHash } = await createSnapshotPdf(
          snapshot,
          MERLIN_LABELS.exportLabels,
          convert,
        );
        return sendJson(response, 200, {
          filename: "rad.pdf",
          pdfBase64: pdf.toString("base64"),
          format,
          outputSha256,
          reportHash,
          ...(format === "pdf"
            ? { docxBase64: docx.toString("base64"), noticeKey: "workExport.plainPdf" }
            : {}),
        });
      } catch {
        return sendProblem(response, 503, "unavailable");
      } finally {
        rendering = false;
      }
    },
  };
}

export function createWorkPdfRouteFor(
  main: Pick<Databases["main"], "withActor">,
  rendererOrigin: string | undefined,
): Route {
  return createWorkPdfRoute(readPdfSource(main.withActor), localPdfConverter(rendererOrigin));
}

// SRV-1807: the 24 hour link to the export package and the confirmation for the registrar.
export {
  createSubmissionPackageRoutes,
  createSubmissionPackageRoutesFor,
  type SubmissionPackageRouteDeps,
} from "./submission-package.ts";
// SRV-V14-SHEET-CSV: the CSV of one sheet of a spreadsheet work.
export { createSheetCsvRoute, createSheetCsvRouteFor } from "./sheet-csv.ts";
