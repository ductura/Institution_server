// GET /api/v1/institution/admin-actions (SRV-ADMIN-1, NF-7 OA-3; contract
// institution.admin-actions.get): the log of administrator and operator
// actions of the caller's institution, read only. Who may read it (a
// confirmed administrator) is the database's. A cross-site request and any
// query are refused; an answer outside the contract, or a throw, is 503 and
// the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ADMIN_ACTIONS_PAGE, adminActionsGet } from "../../contracts/index.ts";
import { createAdminActionLog, type AdminActionLog, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

const BODY = adminActionsGet.responses[0]!.body!;

export function createAdminActionLogRoute(log: AdminActionLog): Route {
  return {
    contract: adminActionsGet,
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
        const result = await log.read(token, ADMIN_ACTIONS_PAGE);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "forbidden") return sendProblem(response, 403, "forbidden");
        if (result.status === "ok") {
          const answer = { entries: result.entries, truncated: result.truncated };
          if (Value.Check(BODY, answer)) return sendJson(response, 200, answer);
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            adminActionsGet.id,
          );
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), adminActionsGet.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The route over main's application withActor; server/server.ts mounts it. */
export function createAdminActionLogRouteFor(main: { withActor: WithActor }): Route {
  return createAdminActionLogRoute(createAdminActionLog(main.withActor));
}
