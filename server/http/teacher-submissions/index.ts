import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createTeacherSubmissions,
  type TeacherSubmissions,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { sendJson, sendProblem, type Route } from "../index.ts";

export function createTeacherSubmissionDetailRoute(read: TeacherSubmissions["detail"]): Route {
  const contract = ROUTES.find((entry) => entry.id === "teacher.submission-detail.get");
  if (contract === undefined) throw new Error("Missing teacher submission detail contract");
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = workIdFromPath(params?.assignmentId ?? "") ?? "";
      const submissionId = workIdFromPath(params?.submissionId ?? "") ?? "";
      const result = await read(token, assignmentId, submissionId);
      switch (result.status) {
        case "ok":
          return sendJson(response, 200, result.body);
        case "unauthenticated":
          return sendProblem(response, 401, "unauthorized");
        case "not_found":
          return sendProblem(response, 404, "not_found");
        case "unavailable":
          return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createTeacherSubmissionDetailRouteFor(main: { withActor: WithActor }): Route {
  return createTeacherSubmissionDetailRoute(createTeacherSubmissions(main.withActor).detail);
}
