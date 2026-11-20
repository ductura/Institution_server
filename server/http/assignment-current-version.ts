import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { readAssignmentCurrentVersion } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { decodeOnce } from "./institution-courses.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = ROUTES.find((route) => route.id === "institution.assignment.get")!;
const BODY = CONTRACT.responses.find((response) => response.status === 200)!.body;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function createAssignmentCurrentVersionRouteFor(
  main: Pick<Databases["main"], "withActor">,
): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = decodeOnce(params?.assignmentId);
      if (!UUID.test(assignmentId)) return sendProblem(response, 422, "invalid_input");
      try {
        const result = await readAssignmentCurrentVersion(
          main.withActor,
          token,
          assignmentId.toLowerCase(),
        );
        if (result.kind === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.kind === "not_found") return sendProblem(response, 404, "not_found");
        if (typeof BODY !== "object" || !Value.Check(BODY, result.body)) {
          throw new Error("current assignment answer outside its contract");
        }
        sendJson(response, 200, result.body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}
