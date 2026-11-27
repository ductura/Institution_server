// GET /api/v1/student/submissions/{submissionId}/portable-record
// (student.portable-record.get, SRV-1312, plan M7.10): the portable record of
// the caller's own submission as a deterministic ZIP. The HTTP edge only:
// same-origin fetch (403), a live session cookie (401), the submission id
// (another's, an unknown and a malformed one are the same 404, C-23), then
// server/database/portable-record for the receipt, the submitted text and
// the key, and server/downloads/portable-record for the checked ZIP. The PDF
// QR needs the configured origin (APP_ORIGIN); without it the route is 503. A
// throw is 503 and reported; a record the port or the builder could not vouch
// for is 503 with one line naming its closed reason, never a value of it.
import type { ServerResponse } from "node:http";

import { receiptPdfHr } from "../../../locales/index.ts";
import { ROUTES } from "../../contracts/index.ts";
import { createPortableRecordReader, type PortableRecordReader } from "../../database/index.ts";
import {
  buildPortableRecord,
  PENDING_DAILY_ROOT,
  PORTABLE_RECORD_FILENAME,
  type PortableDailyRootSource,
} from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  codeForRecord,
  createSubmissionConfirmationCodeFor,
  reportServerError,
  requestIdOf,
  sendProblem,
  type Databases,
  type Route,
  type SubmissionConfirmationCode,
} from "../index.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "student.portable-record.get");
  if (found === undefined) throw new Error("no contract student.portable-record.get");
  return found;
})();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One line on stderr: a closed reason code and the request id, never an id or content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "portable_record_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

export type PortableRecordRouteDeps = {
  readonly read: PortableRecordReader;
  /** The signed root of the day of a receipt; pending until SRV-1311's store and reader exist. */
  readonly dailyRoot: PortableDailyRootSource;
  /** APP_ORIGIN, for the QR of the receipt PDF; null answers 503. */
  readonly origin: string | null;
  /** The bound confirmation code of the submission, under the same session (Dizajn 1.1). */
  readonly code: SubmissionConfirmationCode;
};

export function createPortableRecordRoute(deps: PortableRecordRouteDeps): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const submissionId = params?.submissionId?.toLowerCase() ?? "";
      if (!UUID.test(submissionId)) return sendProblem(response, 404, "not_found");
      if (deps.origin === null) {
        unavailable(response, "origin_missing");
        return sendProblem(response, 503, "unavailable");
      }
      try {
        const read = await deps.read(token, submissionId);
        if (read.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (read.status === "not_found") return sendProblem(response, 404, "not_found");
        if (read.status === "unavailable") {
          unavailable(response, read.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const confirmationCode = await codeForRecord(
          deps.code,
          token,
          submissionId,
          read.rows.receiptPayload,
          response,
          CONTRACT.id,
        );
        if (confirmationCode === null) return;
        const built = await buildPortableRecord({
          submissionId,
          source: read.rows,
          dailyRoot: deps.dailyRoot,
          origin: deps.origin,
          labels: receiptPdfHr,
          confirmationCode,
        });
        if (built.status === "refused") {
          unavailable(response, built.reason);
          return sendProblem(response, 503, "unavailable");
        }
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${PORTABLE_RECORD_FILENAME}"`,
          "cache-control": "private, no-store",
          "content-length": String(built.bytes.byteLength),
          "x-content-type-options": "nosniff",
          "x-content-sha256": built.sha256,
        });
        response.end(Buffer.from(built.bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor; daily roots stay pending until they are stored. */
export function createPortableRecordRouteFor(
  main: Pick<Databases["main"], "withActor">,
  origin: string | null,
): Route {
  return createPortableRecordRoute({
    read: createPortableRecordReader(main.withActor),
    dailyRoot: PENDING_DAILY_ROOT,
    origin,
    code: createSubmissionConfirmationCodeFor(main.withActor),
  });
}
