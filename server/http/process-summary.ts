// POST /api/v1/process-summary (contract projection.process-summary.post;
// B-13 step 3, SRV-23, Ductus#2028). Port of the HTTP edge of Ductus
// src/server/projection/process-summary.ts at 0cdb0f1 onto this server's
// router: origin and Sec-Fetch-Site are pipeline step 7; then the session
// cookie (401), Content-Type application/json with at most charset=utf-8
// (415), the body under the contract's 1 KiB and 5 s, strict UTF-8 JSON (400)
// and exactly {documentId} (422; a role, threshold or time is refused, never
// read). Who asks comes only from the session token, bound into the source
// (app.read_process_summary_source under withActor), which also writes the
// teacher's row of the access log with the surface process_summary in the
// same transaction (PRODUCT §5 rule 17). The 200 body is the reader's JCS
// text, the same bytes for the owner and the teacher (rule 5, D-80 point 6);
// ProcessSummaryV1 is unchanged. Thresholds come from configuration
// (rule 12); a value that is set and invalid is 503 for every reader.
import { ROUTES } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import type { InstitutionEvidencePayloadReader } from "../external/storage/index.ts";
import {
  loadProcessSummaryThresholds,
  sessionProcessSummarySource,
} from "../projection/process-summary.ts";
import {
  type ProcessSummaryReadResult,
  readProcessSummary,
} from "../projection/process-summary-reader.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

export type { ProcessSummaryReadResult };

export const PROCESS_SUMMARY_TIMEOUT_MS = 5_000;
/** application/json, with no parameter but charset=utf-8. */
const MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "projection.process-summary.post");
  if (found === undefined) throw new Error("no contract projection.process-summary.post");
  return found;
})();

/** The summary of one document for the session `token`; null when the thresholds are invalid. */
export type ReadProcessSummary =
  ((token: string, documentId: string) => Promise<ProcessSummaryReadResult>) | null;

export type ProcessSummaryRouteOptions = {
  readonly read: ReadProcessSummary;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** Exactly `{documentId}` with a string value; anything else is null. */
export function parseProcessSummaryBody(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 1) return null;
  const { documentId } = value as { documentId?: unknown };
  return typeof documentId === "string" ? documentId : null;
}

export function createProcessSummaryRoute(options: ProcessSummaryRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? PROCESS_SUMMARY_TIMEOUT_MS;
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, CONTRACT.request.maxBodyBytes ?? 0, timeoutMs);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      const documentId = parseProcessSummaryBody(json.value);
      if (documentId === null) return sendProblem(response, 422, "invalid_input");
      if (options.read === null) {
        unavailable(response, "thresholds_invalid");
        return sendProblem(response, 503, "unavailable");
      }
      let read: ProcessSummaryReadResult;
      try {
        read = await options.read(token, documentId);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      switch (read.status) {
        case "ok":
          // The JCS text unchanged: parsed and written again it is the same
          // bytes, since JSON.stringify keeps the sorted keys and writes
          // strings and integers as JCS does (as evidence-replay.ts).
          return sendJson(response, 200, JSON.parse(read.body) as unknown);
        case "not_found":
          return sendProblem(response, 404, "not_found");
        case "unauthenticated":
          // The same answer as a missing cookie.
          return sendProblem(response, 401, "unauthorized");
        default:
          unavailable(response, read.status === "unavailable" ? read.reason : "unknown");
          return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: Parameters<Route["handle"]>[1], reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "process_summary_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

/**
 * The route over main's application withActor, the storage of every
 * institution (the reader binds it to the institution of the source row) and
 * the thresholds of `env`.
 */
export function createProcessSummaryRouteFor(
  main: { readonly withActor: WithActor },
  deps: { readonly payloads: InstitutionEvidencePayloadReader },
  env: Readonly<Record<string, string | undefined>>,
): Route {
  const thresholds = loadProcessSummaryThresholds(env);
  return createProcessSummaryRoute({
    read:
      thresholds === null
        ? null
        : (token, documentId) =>
            readProcessSummary(
              {
                source: sessionProcessSummarySource(main.withActor, token),
                payloads: deps.payloads,
                thresholds,
              },
              documentId,
            ),
  });
}
