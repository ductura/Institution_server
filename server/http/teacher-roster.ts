import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import { readAssignmentOverview, readTeacherRoster } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { sendJson, type Route } from "./router.ts";

type Reader = (
  token: string,
  withActor: WithActor,
  id: string,
) => Promise<{ kind: "ok"; students: unknown[] } | { kind: "unauthorized" | "unavailable" }>;

function listRoute(id: string, param: string, read: Reader, withActor: WithActor): Route {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const answer = await read(token, withActor, workIdFromPath(params?.[param] ?? "") ?? "");
        if (answer.kind === "ok") {
          return sendJson(response, 200, { students: answer.students });
        }
        if (answer.kind === "unauthorized") return sendProblem(response, 401, "unauthorized");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

export function createTeacherRosterRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  return [
    listRoute("teacher.course-students.get", "courseId", readTeacherRoster, withActor),
    listRoute("teacher.assignment-overview.get", "assignmentId", readAssignmentOverview, withActor),
  ];
}
