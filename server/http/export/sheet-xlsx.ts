// GET /api/v1/works/{documentId}/export/xlsx (work.export-sheet-xlsx.get,
// SRV-V14-SHEET-XLSX, val 14 decision 6): the .xlsx of one saved version of a
// spreadsheet work, for its owner and the teacher of its assignment. The HTTP
// edge only, as work.export.get: a live session cookie (401), the work id decoded
// once by workIdFromPath (one that is not a work id is the same 404 as another's
// work, C-23), the closed query (an optional revision as versionId), then the same
// source as the DOCX (server/database/work-export: access by the replay relation,
// the teacher's access log row, one not_found for every refusal). The stored text
// is read as a spreadsheet and the bytes are rendered from it only, formulas
// computed again, so the same version gives the same bytes and the same
// X-Export-Sheet-Sha256. A work that is not a spreadsheet is the same 404; a
// spreadsheet the export cannot read is a 503 with one line naming a closed
// reason, and a throw is a 503 and reported.
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkExportReader, type WorkExportReader } from "../../database/index.ts";
import { renderSheetXlsx, XLSX_TYPE } from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  reportServerError,
  requestIdOf,
  sendProblem,
  type Databases,
  type Route,
} from "../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.export-sheet-xlsx.get");
  if (found === undefined) throw new Error("no contract work.export-sheet-xlsx.get");
  return found;
})();

const REVISION = /^[1-9][0-9]{0,15}$/;

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "sheet_export_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

type Asked = { readonly revision: number | null } | "invalid";

/** The closed query: only an optional revision as versionId. */
function askedOf(url: string | undefined): Asked {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  if ([...query.keys()].some((key) => key !== "versionId")) return "invalid";
  if (query.getAll("versionId").length > 1) return "invalid";
  const version = query.get("versionId");
  if (version === null) return { revision: null };
  return REVISION.test(version) && Number.isSafeInteger(Number(version))
    ? { revision: Number(version) }
    : "invalid";
}

export function createSheetXlsxRoute(read: WorkExportReader): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      const asked = askedOf(request.url);
      if (asked === "invalid") return sendProblem(response, 422, "invalid_input");
      try {
        const source = await read(token, documentId, asked.revision);
        if (source.status !== "found") {
          if (source.status === "unauthenticated")
            return sendProblem(response, 401, "unauthorized");
          if (source.status === "not_found") return sendProblem(response, 404, "not_found");
          if (source.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
          unavailable(response, source.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const xlsx = renderSheetXlsx({ body: source.body });
        if (xlsx.status === "not_spreadsheet") return sendProblem(response, 404, "not_found");
        if (xlsx.status === "unreadable") {
          unavailable(response, xlsx.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const bytes = xlsx.bytes;
        response.writeHead(200, {
          "content-type": XLSX_TYPE,
          "content-length": String(bytes.byteLength),
          "content-disposition": 'attachment; filename="rad.xlsx"',
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-export-sheet-sha256": xlsx.sheetSha256,
        });
        response.end(Buffer.from(bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createSheetXlsxRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createSheetXlsxRoute(createWorkExportReader(main.withActor));
}
