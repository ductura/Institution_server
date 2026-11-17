// POST /api/v1/support/problem-report (DAN-851-2d1; contract Ductus#1836
// c.6947514907). Port of the HTTP edge of Ductus handleProblemReport
// (src/server/support/problem-report-route.ts) and
// app/api/support/problem-report/route.ts at 81833ca, over the support service
// (server/support) and its database port. Origin and Sec-Fetch-Site are
// pipeline step 7. Deviations from Ductus, as in DAN-851-1d1: the token is
// liveSessionToken (a session this browser ended reads as none), activity is
// counted after the 201 is written, and a 503 is logged with a closed reason,
// never a SQLSTATE. server/server.ts mounts it over the main database through
// createProblemReportRouteFor (DAN-851-2d2a).
import { ROUTES } from "../contracts/index.ts";
import { createProblemReportStore, type ProblemReportStore } from "../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";
import { createSupportService } from "../support/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "support.problem-report.post");
  if (found === undefined) throw new Error("no contract support.problem-report.post");
  return found;
})();

export const PROBLEM_REPORT_MAX_BYTES = CONTRACT.request.maxBodyBytes ?? 8 * 1024;
export const PROBLEM_REPORT_TIMEOUT_MS = 5_000;

export type ProblemReportRouteOptions = {
  readonly store: ProblemReportStore;
  /** Session activity for a recorded report (session/recordActivity over the app withActor). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The contract error of each code the caller caused; any other code is 503 unavailable. */
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["PROBLEM_REPORT_INVALID_JSON", [400, "invalid_json"]],
  ["PROBLEM_REPORT_INVALID_BODY", [422, "invalid_input"]],
  ["PROBLEM_REPORT_INVALID", [422, "invalid_input"]],
  ["PROBLEM_REPORT_UNAUTHENTICATED", [401, "unauthorized"]],
  ["PROBLEM_REPORT_TOO_MANY", [429, "too_many_reports"]],
]);

/** The closed reasons a 503 is logged with (Ductus logs its SQLSTATE or row_malformed). */
const FAULTS: ReadonlyMap<string, ProblemReportFault> = new Map([
  ["PROBLEM_REPORT_ROW_MALFORMED", "row_malformed"],
  ["PROBLEM_REPORT_DATABASE_ERROR", "database_error"],
]);
export type ProblemReportFault = "row_malformed" | "database_error" | "unknown";
export type ProblemReportFaultRecord = {
  readonly event: "problem_report_fault";
  readonly route: string;
  readonly reason: ProblemReportFault;
  readonly requestId: string;
};
/** One JSON line on stderr, as reportServerError writes; never throws. */
function recordFault(record: ProblemReportFaultRecord): void {
  try {
    console.error(JSON.stringify(record));
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/** POST of a problem report over the support service. */
export function createProblemReportRoute(options: ProblemReportRouteOptions): Route {
  const service = createSupportService({ store: options.store });
  const timeoutMs = options.timeoutMs ?? PROBLEM_REPORT_TIMEOUT_MS;
  return {
    contract: CONTRACT,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(request, PROBLEM_REPORT_MAX_BYTES, timeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      try {
        const submitted = await service.submitProblemReport(token, body.bytes);
        if (!submitted.ok) {
          const refusal = REFUSALS.get(submitted.error.code);
          if (refusal !== undefined) return sendProblem(response, refusal[0], refusal[1]);
          recordFault({
            event: "problem_report_fault",
            route: CONTRACT.id,
            reason: FAULTS.get(submitted.error.code) ?? "unknown",
            requestId: requestIdOf(response),
          });
          return sendProblem(response, 503, "unavailable");
        }
        sendJson(response, 201, { reference: submitted.value });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only a recorded report counts, once its answer is written; a failure costs only the touch.
      void options.recordActivity(token).catch(() => undefined);
    },
  };
}

/**
 * The route over the main database (DAN-851-2d2a): the port and the activity
 * touch both run on main's application withActor, so a report and its touch
 * never reach another pool.
 */
export function createProblemReportRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createProblemReportRoute({
    store: createProblemReportStore(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
