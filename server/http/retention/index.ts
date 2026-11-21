import { retentionGet, type RetentionReport } from "../../contracts/index.ts";
import { createRetentionDryRunReader, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

/**
 * GET /api/v1/institution/retention (SRV-1304, plan M10.2 and M10.7). The
 * administrator of the session's institution reads the dry run of the data
 * classes: per class its period, mode and how many rows a deletion would
 * take. The handler adds the same-origin read and no query; the database
 * decides who is the administrator (ZD403 for everyone else) and never
 * deletes anything.
 */
export function createRetentionRouteFor({ withActor }: { withActor: WithActor }): Route {
  const read = createRetentionDryRunReader(withActor);
  return {
    contract: retentionGet,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await read(token);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "forbidden") return sendProblem(response, 403, "forbidden");
        const body: RetentionReport = { classes: [...result.classes] };
        sendJson(response, 200, body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), retentionGet.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}
