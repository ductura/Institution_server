// GET /api/v1/student/assignments (student.assignments.get, SRV-09, Ductus#2028
// c.7008147932): the caller's courses and the current version of every
// assignment in each, over institution.student_assignments() (SRV-08). The
// HTTP edge only, as profile-me.ts: Sec-Fetch-Site, when sent, exactly one
// same-origin (403), then a live session cookie (401); a read the port cannot
// vouch for, and a throw, are 503. The body is server/institution.
import { ROUTES } from "../contracts/index.ts";
import {
  createStudentAssignmentsReader,
  createStudentMentoredAssignmentsReader,
  type StudentAssignmentsReader,
  type StudentMentoredAssignmentsReader,
} from "../database/index.ts";
import { studentCoursesOf, WORK_TYPES } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const contractOf = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const CONTRACT = contractOf("student.assignments.get");
const MENTORED_CONTRACT = contractOf("student.mentored-assignments.get");

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

// INT-31 (Ductus#2055): GET /api/v1/student/mentored-assignments
// (student.mentored-assignments.get), the assignments of the caller's open
// mentorships over institution.student_mentored_assignments(). The same edge as
// the route above; a work type the contract does not name makes the whole
// answer 503, never a partial list.
export function createStudentMentoredAssignmentsRoute(
  read: StudentMentoredAssignmentsReader,
): Route {
  return {
    contract: MENTORED_CONTRACT,
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
        if (answer.status !== "ok" || answer.rows.some((row) => !WORK_TYPES.has(row.workType))) {
          return sendProblem(response, 503, "unavailable");
        }
        const assignments = answer.rows.map((row) => ({
          id: row.assignmentId,
          mentorshipId: row.mentorshipId,
          title: row.title,
          dueAt: row.dueAt,
          noticeFirst: !row.acknowledged,
          workType: row.workType,
          mentor: row.mentor,
          extendedDueAt: row.extendedDueAt,
        }));
        sendJson(response, 200, { assignments });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), MENTORED_CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The mentored route over main's application withActor. */
export function createStudentMentoredAssignmentsRouteFor(
  main: Pick<Databases["main"], "withActor">,
): Route {
  return createStudentMentoredAssignmentsRoute(
    createStudentMentoredAssignmentsReader(main.withActor),
  );
}
