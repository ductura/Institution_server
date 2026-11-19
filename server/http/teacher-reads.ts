// GET /api/v1/teacher/courses and GET /api/v1/teacher/access (SRV-13,
// Ductus#2028 c.7008147932; contracts teacher.courses.get and
// teacher.access.get). As the account GET (profile-me.ts): one well-formed
// live session cookie, and Sec-Fetch-Site, when sent, must be same-origin (the
// pipeline checks only state-changing methods). Who asks comes only from the
// session token inside withActor; the readers are server/database/teacher-reads.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import {
  createTeacherAccessReader,
  createTeacherCoursesReader,
  type TeacherAccessReader,
  type TeacherCoursesReader,
} from "../database/index.ts";
import { liveSessionTokenFromCookie, principalScope } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const COURSES = contract("teacher.courses.get");
const ACCESS = contract("teacher.access.get");

/** The session token of a same-origin GET, or undefined after answering 403 or 401. */
function tokenOf(request: IncomingMessage, response: ServerResponse): string | undefined {
  const site = request.headersDistinct["sec-fetch-site"];
  if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
    sendProblem(response, 403, "forbidden");
    return undefined;
  }
  const token = liveSessionTokenFromCookie(request.headers.cookie);
  if (token === undefined) sendProblem(response, 401, "unauthorized");
  return token;
}

export function createTeacherCoursesRoute(read: TeacherCoursesReader): Route {
  return {
    contract: COURSES,
    async handle(request, response) {
      const token = tokenOf(request, response);
      if (token === undefined) return;
      try {
        const result = await read(token);
        if (!result.ok) {
          return result.reason === "not_found"
            ? sendProblem(response, 404, "not_found")
            : sendProblem(response, 401, "unauthorized");
        }
        sendJson(response, 200, { courses: result.courses });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), COURSES.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createTeacherAccessRoute(read: TeacherAccessReader): Route {
  return {
    contract: ACCESS,
    async handle(request, response) {
      const token = tokenOf(request, response);
      if (token === undefined) return;
      try {
        const result = await read(token);
        if (!result.ok) return sendProblem(response, 401, "unauthorized");
        sendJson(response, 200, {
          access: result.access,
          scope: principalScope(result.userId, result.institutionId),
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), ACCESS.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** Both routes over main's application withActor. */
export function createTeacherReadRoutesFor(main: Pick<Databases["main"], "withActor">): Route[] {
  return [
    createTeacherCoursesRoute(createTeacherCoursesReader(main.withActor)),
    createTeacherAccessRoute(createTeacherAccessReader(main.withActor)),
  ];
}
