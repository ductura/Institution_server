// GET /api/v1/me/staff-affiliation (profile.staff-affiliation.get, SRV-1403,
// M1.3, DAN-304): the signed-in person's own staff affiliation, or the closed
// code staff_affiliation_missing. The HTTP edge only, as profile-me.ts:
// Sec-Fetch-Site, when sent, exactly one same-origin (403), then a live
// session cookie (401). The answer comes from server/database/staff-
// affiliation.ts, which reads only the session's own row; a body the contract
// does not accept, or a throw, is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createMyStaffAffiliationReader,
  type MyStaffAffiliationReader,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const ID = "profile.staff-affiliation.get";

export function createStaffAffiliationRoute(read: MyStaffAffiliationReader): Route {
  const contract = ROUTES.find((route) => route.id === ID);
  const body = contract?.responses.find((response) => response.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${ID}`);
  return {
    contract,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const result = await read(token);
        if (!result.ok) return sendProblem(response, 401, "unauthorized");
        if (Value.Check(body, result.value)) return sendJson(response, 200, result.value);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          ID,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), ID);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The route over main's application withActor. */
export function createStaffAffiliationRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createStaffAffiliationRoute(createMyStaffAffiliationReader(main.withActor));
}
