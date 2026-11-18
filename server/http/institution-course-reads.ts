// GET /api/v1/institution/academic-years and …/course-list (DAN-1089;
// contract Ductus#2028 c.6968016327): the two reads of the administrator's
// course screen A-03, which Ductus serves from its page (app/ustanova/kolegiji)
// over src/server/institution/institution-courses.ts at 70c168f. The token is
// liveSessionToken, as profile-interface-locale.ts; GET checks Sec-Fetch-Site
// itself (the pipeline skips safe methods). The query of course-list is
// exactly academicYear, once; anything else is 422 and reaches no database.
// Who may read is the database's: a non-administrator is ZD403, 403 here.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import {
  createInstitutionCourseReads,
  type InstitutionCourseReads,
  isAcademicYear,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["invalid", [422, "invalid_input"]],
]);

/** The academic year of a query that holds exactly one parameter, academicYear; else undefined. */
function academicYearOf(url: string | undefined): string | undefined {
  const query = new URL(url ?? "/", "http://query.invalid").searchParams;
  const keys = [...query.keys()];
  return keys.length === 1 && keys[0] === "academicYear"
    ? (query.get("academicYear") ?? undefined)
    : undefined;
}

type Answer = { readonly status: string; readonly body?: Readonly<Record<string, unknown>> };
type Run = (token: string, request: IncomingMessage) => Promise<Answer>;

/** The two reads over the course port; a 200 body is built from named fields only. */
export function createInstitutionCourseReadRoutes(reads: InstitutionCourseReads): Route[] {
  const route = (id: string, run: Run): Route => {
    const contract = ROUTES.find((found) => found.id === id)!;
    return {
      contract,
      async handle(request: IncomingMessage, response: ServerResponse) {
        const site = request.headersDistinct["sec-fetch-site"];
        if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
          return sendProblem(response, 403, "forbidden");
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        try {
          const answer = await run(token, request);
          if (answer.status === "ok" && answer.body) return sendJson(response, 200, answer.body);
          const [status, code] = REFUSALS.get(answer.status) ?? [503, "unavailable"];
          sendProblem(response, status, code);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    };
  };

  return [
    route("institution.academic-years.get", async (token) => {
      const read = await reads.readAcademicYears(token);
      return read.status === "ok" ? { status: "ok", body: { years: read.years } } : read;
    }),
    route("institution.course-list.get", async (token, request) => {
      const year = academicYearOf(request.url);
      if (!isAcademicYear(year)) return { status: "invalid" };
      const read = await reads.readCourses(token, year);
      return read.status === "ok"
        ? { status: "ok", body: { academicYear: read.academicYear, courses: read.courses } }
        : read;
    }),
  ];
}

/** The reads over the main database's application withActor; server/server.ts mounts them. */
export function createInstitutionCourseReadRoutesFor(
  main: Pick<Databases["main"], "withActor">,
): Route[] {
  return createInstitutionCourseReadRoutes(createInstitutionCourseReads(main.withActor));
}
