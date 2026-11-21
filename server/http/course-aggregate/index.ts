import { Value } from "@sinclair/typebox/value";

import {
  CourseAggregateParams,
  courseAggregateGet,
  workIdFromPath,
} from "../../contracts/index.ts";
import { createCourseAggregateReader, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

export function createCourseAggregateRouteFor({ withActor }: { withActor: WithActor }): Route {
  const read = createCourseAggregateReader(withActor);
  return {
    contract: courseAggregateGet,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const input = { id: workIdFromPath(params?.id ?? "") };
      if (!Value.Check(CourseAggregateParams, input)) {
        return sendProblem(response, 404, "not_found");
      }
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await read(token, input.id.toLowerCase());
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        sendJson(response, 200, result);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), courseAggregateGet.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}
