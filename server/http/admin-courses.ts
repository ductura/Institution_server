// POST /api/v1/institution/admin/courses (SRV-12, Ductus#2028 c.7008147932;
// contract institution.admin-courses.post) over institution.admin_create_course
// (SRV-07), behind the same JSON reader as the course routes. The holder
// becomes the course's first teacher; the administrator does not become a
// member (A-7). Groups (F4 wave 2 #9, 1.9): up to 20 distinct names, each as
// institution.course-groups.post takes it, made in the course's transaction by
// create_seminar_group, which the administrator of the course's institution
// may call (migration 20261119170000); the answer names each with its id.
import { ROUTES } from "../contracts/index.ts";
import { type AdminCourseInput, type AdminCourses, createAdminCourses } from "../database/index.ts";
import { parseCourseBody } from "../institution/index.ts";
import { recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { INSTITUTION_BODY_TIMEOUT_MS, readInstitutionJson } from "./institution-courses.ts";
import { isGroupName } from "./institution-groups.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTRACT = ROUTES.find((route) => route.id === "institution.admin-courses.post")!;
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["conflict", [409, "conflict"]],
  ["invalid", [422, "invalid_input"]],
] as const);

const MAX_GROUPS = 20;

/**
 * Exactly {name, academicYear, aiPolicy, holderId, groups}: the first three as
 * the teacher's course body (parseCourseBody), holderId a UUID and groups at
 * most 20 distinct group names (isGroupName). Null is the route's 422.
 */
export function parseAdminCourseBody(value: unknown): AdminCourseInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { holderId, groups, ...course } = value as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 5 || !keys.includes("holderId") || !keys.includes("groups")) return null;
  const parsed = parseCourseBody(course);
  if (parsed === null || typeof holderId !== "string" || !UUID.test(holderId)) return null;
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS || !groups.every(isGroupName)) {
    return null;
  }
  if (new Set(groups).size !== groups.length) return null;
  return { ...parsed, holderId: holderId.toLowerCase(), groups: [...groups] };
}

export type AdminCourseRouteOptions = {
  readonly courses: AdminCourses;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

export function createAdminCourseRoute(options: AdminCourseRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  const maxBytes = CONTRACT.request.maxBodyBytes ?? 64;
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const input = await readInstitutionJson(request, response, [], maxBytes, timeoutMs);
      if (input === null) return;
      const course = parseAdminCourseBody(input.value);
      if (course === null) return sendProblem(response, 422, "invalid_input");
      try {
        const outcome = await options.courses.createCourse(input.token, course);
        if (outcome.status !== "created") {
          const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
          return sendProblem(response, status, code);
        }
        sendJson(response, 200, { id: outcome.id, groups: outcome.groups });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted answer counts, once written; a failure costs only the touch.
      void options.recordActivity(input.token).catch(() => undefined);
    },
  };
}

/** The route over main's application withActor; server/server.ts mounts it. */
export function createAdminCourseRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createAdminCourseRoute({
    courses: createAdminCourses(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
