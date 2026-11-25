// GET /api/v1/works/{documentId}/export/csv (work.export-sheet-csv.get,
// SRV-V14-SHEET-CSV, val 14 decision 6): the CSV of one sheet of a work of kind
// spreadsheet, for its owner and the teacher of its assignment. The HTTP edge
// only, as work-export: a live session cookie (401), the work id decoded once
// by workIdFromPath (one that is not a work id is the same 404 as another's
// work, C-23), the closed query (an optional sheet id, else 422), then the
// same reader as the DOCX export for the newest saved version, so the access
// rule and the teacher's access log row are the same. The stored text must be
// a valid spreadsheet document; a text work, or a body that is not one, is the
// same 404 as another's work. The formulas are computed again here (decision 4)
// and the bytes come from renderSheetCsv only.
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkExportReader, type WorkExportReader } from "../../database/index.ts";
import { renderSheetCsvOfText } from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  reportServerError,
  requestIdOf,
  sendProblem,
  type Databases,
  type Route,
} from "../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.export-sheet-csv.get");
  if (found === undefined) throw new Error("no contract work.export-sheet-csv.get");
  return found;
})();

const SHEET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "sheet_csv_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

type Asked = { readonly sheet: string | null } | "invalid";

/** The closed query: only an optional sheet, once, as a sheet id. */
function askedOf(url: string | undefined): Asked {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  if ([...query.keys()].some((key) => key !== "sheet")) return "invalid";
  const sheets = query.getAll("sheet");
  if (sheets.length > 1) return "invalid";
  const sheet = sheets[0];
  if (sheet === undefined) return { sheet: null };
  return SHEET_ID.test(sheet) ? { sheet } : "invalid";
}

export function createSheetCsvRoute(read: WorkExportReader): Route {
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
        const source = await read(token, documentId, null);
        if (source.status !== "found") {
          if (source.status === "unauthenticated")
            return sendProblem(response, 401, "unauthorized");
          if (source.status === "not_found") return sendProblem(response, 404, "not_found");
          if (source.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
          unavailable(response, source.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const csv = renderSheetCsvOfText(source.body, asked.sheet);
        if (csv.status !== "ok") return sendProblem(response, 404, "not_found");
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-length": String(csv.bytes.byteLength),
          "content-disposition": 'attachment; filename="rad.csv"',
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(Buffer.from(csv.bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createSheetCsvRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createSheetCsvRoute(createWorkExportReader(main.withActor));
}
