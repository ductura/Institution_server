// GET /api/v1/works/{documentId}/export-slides (work.export-slides.get,
// SRV-V13-RUTA-IZVOZ, val 13): the .pptx or the PDF of one saved version of a
// slides work, for its owner and the teacher of its assignment. The HTTP edge
// only, as work.export.get: a live session cookie (401), the work id decoded
// once by workIdFromPath (one that is not a work id is the same 404 as
// another's work, C-23), the closed query (format pptx|pdf, an optional
// revision as versionId; anything else is 422), then the same source as the
// DOCX (server/database/work-export: access by the replay relation, the
// teacher's access log row, one not_found for every refusal). The stored text
// is read as a slides document, the images it binds are read through the
// attachments the caller may read, and the bytes are rendered from that
// snapshot only. A work that is not a slides work is the same 404; a conversion
// that is missing, times out or fails, a slides document the export cannot
// read and an image it cannot print are a 503 with one line naming a closed
// reason; a throw is a 503 and reported. At most one PDF is converted at a
// time, as for the DOCX PDF; another is a 503.
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkExportReader, type WorkExportReader } from "../../database/index.ts";
import {
  localSlidesPdfConverter,
  PPTX_TYPE,
  renderSlidesExport,
  slidesBodyKind,
  type ConvertPptx,
  type SlidesExportFormat,
} from "../../downloads/index.ts";
import { messagesHr } from "../../../locales/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { createAttachmentBytesReaderFor } from "../attachments/index.ts";
import {
  reportServerError,
  requestIdOf,
  sendProblem,
  type Databases,
  type Route,
} from "../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.export-slides.get");
  if (found === undefined) throw new Error("no contract work.export-slides.get");
  return found;
})();

const REVISION = /^[1-9][0-9]{0,15}$/;

/** The bytes of one stored image the caller may read, or null for a refusal or a missing one. */
export type SlideImageReader = (token: string, attachmentId: string) => Promise<Uint8Array | null>;

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "slides_export_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

type Asked = { readonly format: SlidesExportFormat; readonly revision: number | null } | "invalid";

/** The closed query: format is pptx or pdf and versionId an optional revision. */
function askedOf(url: string | undefined): Asked {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  if ([...query.keys()].some((key) => key !== "format" && key !== "versionId")) return "invalid";
  if (query.getAll("format").length !== 1 || query.getAll("versionId").length > 1) return "invalid";
  const format = query.get("format");
  if (format !== "pptx" && format !== "pdf") return "invalid";
  const version = query.get("versionId");
  if (version === null) return { format, revision: null };
  return REVISION.test(version) && Number.isSafeInteger(Number(version))
    ? { format, revision: Number(version) }
    : "invalid";
}

export function createWorkExportSlidesRoute(
  read: WorkExportReader,
  readImage: SlideImageReader,
  convert: ConvertPptx | undefined,
): Route {
  let converting = false;
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
      const pdf = asked.format === "pdf";
      let holding = false;
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
        const kind = slidesBodyKind(source.body);
        if (kind.kind === "not_slides") return sendProblem(response, 404, "not_found");
        if (kind.kind === "unreadable") {
          unavailable(response, kind.reason);
          return sendProblem(response, 503, "unavailable");
        }
        if (pdf) {
          if (converting) {
            unavailable(response, "pdf_busy");
            return sendProblem(response, 503, "unavailable");
          }
          converting = true;
          holding = true;
        }
        const images = new Map<string, Uint8Array>();
        for (const attachmentId of kind.attachmentIds) {
          const bytes = await readImage(token, attachmentId);
          if (bytes !== null) images.set(attachmentId, bytes);
        }
        const exported = await renderSlidesExport({
          body: source.body,
          images,
          labels: messagesHr.slidesExport,
          format: asked.format,
          convert,
        });
        if (exported.status !== "rendered") {
          if (exported.status === "not_slides") return sendProblem(response, 404, "not_found");
          unavailable(response, "reason" in exported ? exported.reason : exported.status);
          return sendProblem(response, 503, "unavailable");
        }
        const bytes = exported.bytes;
        response.writeHead(200, {
          "content-type": pdf ? "application/pdf" : PPTX_TYPE,
          "content-length": String(bytes.byteLength),
          "content-disposition": `attachment; filename="rad.${asked.format}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-export-snapshot-sha256": exported.snapshotSha256,
        });
        response.end(Buffer.from(bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      } finally {
        if (holding) converting = false;
      }
    },
  };
}

/** The route over main's application withActor, the attachment store and the local converter. */
export function createWorkExportSlidesRouteFor(
  main: Pick<Databases["main"], "withActor">,
  env: NodeJS.ProcessEnv,
  root: string,
): Route {
  return createWorkExportSlidesRoute(
    createWorkExportReader(main.withActor),
    createAttachmentBytesReaderFor(main, env, root),
    localSlidesPdfConverter(env.DUCTURA_PDF_RENDERER_ORIGIN),
  );
}
