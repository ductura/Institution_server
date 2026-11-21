// GET /api/v1/works/{documentId}/export (work.export.get, SRV-1310, plan M8.4):
// the DOCX of one saved version of a work, for its owner and the teacher of its
// assignment. The HTTP edge only, as work-versions.ts: a live session cookie
// (401), the work id decoded once by workIdFromPath (one that is not a work id
// is the same 404 as another's work, C-23), the closed query (format docx;
// pdf is not ready and is 422; an optional revision as versionId), then
// server/database/work-export for the text of the version. The text is frozen
// as an export snapshot (SRV-1309) and the bytes are rendered from that
// snapshot only, so the same version gives the same bytes and the same
// X-Export-Snapshot-Sha256 every time. A throw is 503 and reported; a row the
// port could not vouch for is 503 with one line naming its closed reason.
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkExportReader, type WorkExportReader } from "../../database/index.ts";
import { renderWorkDocx } from "../../downloads/index.ts";
import { merlinHr } from "../../../locales/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  reportServerError,
  requestIdOf,
  sendProblem,
  type Databases,
  type Route,
} from "../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.export.get");
  if (found === undefined) throw new Error("no contract work.export.get");
  return found;
})();

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REVISION = /^[1-9][0-9]{0,15}$/;

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "work_export_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

type Asked = { readonly revision: number | null } | "invalid";

/** The closed query: format is docx (pdf is refused, not ready) and versionId a revision. */
function askedOf(url: string | undefined): Asked {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  const keys = [...query.keys()];
  if (keys.some((key) => key !== "format" && key !== "versionId")) return "invalid";
  if (query.getAll("format").length !== 1 || query.getAll("versionId").length > 1) return "invalid";
  if (query.get("format") !== "docx") return "invalid";
  const version = query.get("versionId");
  if (version === null) return { revision: null };
  return REVISION.test(version) && Number.isSafeInteger(Number(version))
    ? { revision: Number(version) }
    : "invalid";
}

export function createWorkExportRoute(read: WorkExportReader): Route {
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
        const docx = renderWorkDocx({
          body: source.body,
          revision: source.revision,
          kind: source.kind,
          savedAt: source.savedAt,
          labels: merlinHr.exportLabels,
        });
        if (docx.status === "unreadable") {
          unavailable(response, docx.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const bytes = docx.bytes;
        response.writeHead(200, {
          "content-type": DOCX_TYPE,
          "content-length": String(bytes.byteLength),
          "content-disposition": 'attachment; filename="rad.docx"',
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-export-snapshot-sha256": docx.snapshotSha256,
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
export function createWorkExportRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createWorkExportRoute(createWorkExportReader(main.withActor));
}
