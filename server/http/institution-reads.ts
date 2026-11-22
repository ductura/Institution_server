// LOK-SRV-2: the administrator's reads of the institution (contracts
// institution.admin-courses.get, institution.academic-years.get and
// institution.teacher-roles.get) over the readers of server/institution
// (DAN-313, DAN-581). The handler adds the same-origin read, the session and
// the query; the database decides who is the administrator. Its notFound
// (ZD403, anyone who is not a confirmed administrator) is the same 403 as the
// other administrator reads (institution.retention.get).
import { ROUTES } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import {
  readAcademicYears,
  readInstitutionCourses,
  readTeacherRoles,
} from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { sendJson, type Route } from "./router.ts";

type Refusal = { kind: "unauthorized" | "notFound" | "invalid" | "unavailable" };
type Answer = { kind: "ok"; body: unknown } | Refusal;
type Read = (token: string, query: URLSearchParams) => Promise<Answer>;

const REFUSALS = {
  unauthorized: [401, "unauthorized"],
  notFound: [403, "forbidden"],
  invalid: [422, "invalid_input"],
  unavailable: [503, "unavailable"],
} as const;

function readRoute(id: string, read: Read): Route {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return {
    contract,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      const query = new URLSearchParams(queryAt >= 0 ? target.slice(queryAt + 1) : "");
      try {
        const answer = await read(token, query);
        if (answer.kind === "ok") return sendJson(response, 200, answer.body);
        const [status, code] = REFUSALS[answer.kind];
        return sendProblem(response, status, code);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

const INVALID: Refusal = { kind: "invalid" };

export function createInstitutionReadRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  return [
    readRoute("institution.admin-courses.get", async (token, query) => {
      const years = query.getAll("academicYear");
      if (query.size !== 1 || years.length !== 1) return INVALID;
      const answer = await readInstitutionCourses(token, years[0], withActor);
      if (answer.kind !== "ok") return answer;
      return { kind: "ok", body: { academicYear: answer.academicYear, courses: answer.courses } };
    }),
    readRoute("institution.academic-years.get", async (token, query) => {
      if (query.size > 0) return INVALID;
      const answer = await readAcademicYears(token, withActor);
      return answer.kind === "ok" ? { kind: "ok", body: { years: answer.years } } : answer;
    }),
    readRoute("institution.teacher-roles.get", async (token, query) => {
      if (query.size > 0) return INVALID;
      const answer = await readTeacherRoles(token, withActor);
      if (answer.kind !== "ok") return answer;
      return { kind: "ok", body: { pending: answer.pending, confirmed: answer.confirmed } };
    }),
  ];
}
