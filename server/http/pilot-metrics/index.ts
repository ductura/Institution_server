import {
  pilotMetricsGet,
  PILOT_METRICS_MIN_GROUP,
  type PilotMetrics,
} from "../../contracts/index.ts";
import { createPilotMetricsReader, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

/**
 * GET /api/v1/ops/pilot-metrics (SRV-1906, plan P-D6). An operator path:
 * step 8 of the pipeline lets only a listed operator with a confirmed second
 * factor reach this handler. The handler adds the same-origin read, no query
 * and the numbers of the database, which already hides small groups.
 */
export function createPilotMetricsRouteFor({ withActor }: { withActor: WithActor }): Route {
  const read = createPilotMetricsReader(withActor);
  return {
    contract: pilotMetricsGet,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthenticated");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await read(token);
        if (result.status === "unauthenticated") {
          return sendProblem(response, 401, "unauthenticated");
        }
        const m = result.metrics;
        const body: PilotMetrics = {
          asOf: m.asOf.toISOString(),
          minimumGroup: PILOT_METRICS_MIN_GROUP,
          submissions: { recorded: m.submissionsRecorded, notRecorded: m.submissionsNotRecorded },
          receipts: { issued: m.receiptsIssued, pending: m.receiptsPending },
          helpRequests: { total: m.helpRequests, saveProblems: m.saveProblemReports },
          receiptTime: { p50Ms: m.receiptP50Ms, p95Ms: m.receiptP95Ms },
        };
        sendJson(response, 200, body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), pilotMetricsGet.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}
