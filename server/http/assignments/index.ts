import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

const GRADE = ROUTES.find((route) => route.id === "teacher.assignment-grade.get")!;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function createAssignmentGradeRouteFor({ withActor }: { withActor: WithActor }): Route {
  return {
    contract: GRADE,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const id = params?.assignmentId ?? "";
      if (!UUID.test(id)) return sendProblem(response, 404, "not_found");
      try {
        const { rows } = await withActor(token, (tx) =>
          tx.query<{ state: string }>(
            "SELECT institution.assignment_grade_state($1::uuid) AS state",
            [id],
          ),
        );
        if (rows.length !== 1) throw new Error("invalid assignment grade row count");
        switch (rows[0]?.state) {
          case "eligible":
            return sendJson(response, 200, { eligible: true });
          case "practice":
            return sendProblem(response, 409, "practice_assignment");
          case "not_found":
            return sendProblem(response, 404, "not_found");
          case "unauthorized":
            return sendProblem(response, 401, "unauthorized");
          default:
            throw new Error("invalid assignment grade state");
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GRADE.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The PDF and Merlin roster routes carry assignmentId and use this filter before exporting. */
export function excludePracticeAssignment(
  route: Route,
  { withActor }: { withActor: WithActor },
): Route {
  return {
    contract: route.contract,
    async handle(request, response, params) {
      const id = params?.assignmentId ?? "";
      const site = request.headersDistinct["sec-fetch-site"];
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (
        token !== undefined &&
        UUID.test(id) &&
        (site === undefined || (site.length === 1 && site[0] === "same-origin"))
      ) {
        try {
          const { rows } = await withActor(token, (tx) =>
            tx.query<{ practice: boolean | null }>(
              `SELECT a.is_practice AS practice FROM app.current_actor() actor
               LEFT JOIN institution.assignment a ON a.id = $1::uuid
               WHERE actor.user_id IS NOT NULL`,
              [id],
            ),
          );
          if (rows.length === 0) return sendProblem(response, 401, "unauthorized");
          if (rows.length !== 1) throw new Error("invalid assignment export row count");
          // Only a visible regular assignment may reach the exporter. If access
          // is granted between the reads, a hidden practice assignment stays blocked.
          if (rows[0]?.practice !== false) return sendProblem(response, 404, "not_found");
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), route.contract.id);
          return sendProblem(response, 503, "unavailable");
        }
      }
      return route.handle(request, response, params);
    },
  };
}
