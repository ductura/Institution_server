// POST /api/v1/institution/courses/{courseId}/groups and
// POST /api/v1/institution/groups/{groupId}/teachers (SRV-15, Ductus#2028
// c.7008147932; contracts institution.course-groups.post and
// institution.course-group-teachers.post), behind the same JSON reader as the
// course routes, and GET /api/v1/institution/courses/{courseId}/groups
// (institution.course-groups.get), the edge of profile-me.ts: Sec-Fetch-Site,
// when sent, exactly one same-origin (403), then a live session cookie (401),
// then a course id that is a UUID (422). Who may is the RPC's (owner decision
// "A opcija", c.7016215710); the caller comes only from the session.
import { ROUTES } from "../contracts/index.ts";
import {
  createInstitutionGroups,
  type GroupCreateOutcome,
  type GroupTeacherOutcome,
  type InstitutionGroups,
} from "../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import {
  decodeOnce,
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
} from "./institution-courses.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type InstitutionGroupRouteOptions = {
  readonly groups: InstitutionGroups;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["invalid", [422, "invalid_input"]],
] as const);

/** The one own string field `name` of an object with no other key, or null. */
function onlyField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === name ? (value as Record<string, unknown>)[name] : null;
}

/** A group name: 1 to 80 UTF-16 units, no white space at either end (the RPC judges further). */
export function parseGroupBody(value: unknown): string | null {
  const name = onlyField(value, "name");
  return typeof name === "string" && name.length >= 1 && name.length <= 80 && name.trim() === name
    ? name
    : null;
}

/** A teacher id, a UUID in any case; lower case for the RPC. */
export function parseGroupTeacherBody(value: unknown): string | null {
  const id = onlyField(value, "teacherId");
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

type Outcome = GroupCreateOutcome | GroupTeacherOutcome;

/** GET institution.course-groups.get over the port; nothing is written, no activity is recorded. */
function courseGroupsRoute(groups: InstitutionGroups): Route {
  const contract = ROUTES.find((found) => found.id === "institution.course-groups.get")!;
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const courseId = decodeOnce(params?.courseId);
      if (!UUID.test(courseId)) return sendProblem(response, 422, "invalid_input");
      try {
        const outcome = await groups.readCourseGroups(token, courseId.toLowerCase());
        if (outcome.status === "read") return sendJson(response, 200, { groups: outcome.groups });
        const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
        return sendProblem(response, status, code);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createInstitutionGroupRoutes(options: InstitutionGroupRouteOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;

  const route = (
    id: string,
    param: string,
    run: (token: string, value: unknown, pathId: string) => Promise<Outcome | null>,
  ): Route => {
    const contract = ROUTES.find((found) => found.id === id)!;
    return {
      contract,
      async handle(request, response, params) {
        const pathId = decodeOnce(params?.[param]);
        const maxBytes = contract.request.maxBodyBytes ?? 64;
        const input = await readInstitutionJson(request, response, [pathId], maxBytes, timeoutMs);
        if (input === null) return;
        try {
          const outcome = await run(input.token, input.value, pathId.toLowerCase());
          if (outcome === null) return sendProblem(response, 422, "invalid_input");
          if (outcome.status === "created") sendJson(response, 200, { id: outcome.id });
          else if (outcome.status === "assigned") {
            sendJson(response, 200, { assigned: outcome.assigned });
          } else {
            const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
            return sendProblem(response, status, code);
          }
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
        // Only an accepted answer counts, once written; a failure costs only the touch.
        void options.recordActivity(input.token).catch(() => undefined);
      },
    };
  };

  return [
    courseGroupsRoute(options.groups),
    route("institution.course-groups.post", "courseId", async (token, value, courseId) => {
      const name = parseGroupBody(value);
      return name === null ? null : options.groups.createGroup(token, courseId, name);
    }),
    route("institution.course-group-teachers.post", "groupId", async (token, value, groupId) => {
      const teacherId = parseGroupTeacherBody(value);
      return teacherId === null
        ? null
        : options.groups.assignGroupTeacher(token, groupId, teacherId);
    }),
  ];
}

/** The three routes over main's application withActor; server/server.ts mounts them. */
export function createInstitutionGroupRoutesFor(
  main: Pick<Databases["main"], "withActor">,
): Route[] {
  return createInstitutionGroupRoutes({
    groups: createInstitutionGroups(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
