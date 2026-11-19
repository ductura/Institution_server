// GET /api/v1/student/assignments (student.assignments.get, SRV-09, Ductus#2028
// c.7008147932): the caller's courses and the current version of every
// assignment in each, over institution.student_assignments() (SRV-08). The
// HTTP edge only, as profile-me.ts: Sec-Fetch-Site, when sent, exactly one
// same-origin (403), then a live session cookie (401); a read the port cannot
// vouch for, and a throw, are 503. The body is server/institution.
import { ROUTES } from "../contracts/index.ts";
import {
  createStudentAssignmentsReader,
  type StudentAssignmentsReader,
} from "../database/index.ts";
import { studentCoursesOf } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "student.assignments.get");
  if (found === undefined) throw new Error("no contract student.assignments.get");
  return found;
})();

export function createStudentAssignmentsRoute(read: StudentAssignmentsReader): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const answer = await read(token);
        if (answer.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        const courses = answer.status === "ok" ? studentCoursesOf(answer.rows) : null;
        if (courses === null) return sendProblem(response, 503, "unavailable");
        sendJson(response, 200, { courses });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createStudentAssignmentsRouteFor(
  main: Pick<Databases["main"], "withActor">,
): Route {
  return createStudentAssignmentsRoute(createStudentAssignmentsReader(main.withActor));
}
