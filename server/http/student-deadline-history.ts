import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createStudentDeadlineHistoryReader, type WithActor } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { sendJson, type Route } from "./router.ts";

const CONTRACT = ROUTES.find((route) => route.id === "student.deadline-history.get")!;
const BODY = CONTRACT.responses[0]!.body!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function createStudentDeadlineHistoryRouteFor(main: { withActor: WithActor }): Route {
  const read = createStudentDeadlineHistoryReader(main.withActor);
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");

      try {
        const result = await read(token, assignmentId.toLowerCase());
        if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        const answer = { extensions: result.extensions };
        if (!Value.Check(BODY, answer)) throw new Error("deadline history outside contract");
        return sendJson(response, 200, answer);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}
