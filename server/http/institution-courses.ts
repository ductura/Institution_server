// POST /api/v1/institution/courses (DAN-852-4a; contract Ductus#1836
// c.6947710352). Port of the HTTP edge of Ductus create-course.ts and the
// shared front readJsonMutation (src/server/institution/mutation-route.ts)
// at 078c780, over the institution service (server/institution). Changes:
// the token is liveSessionToken, as profile-interface-locale.ts; origin is
// pipeline step 7; a byte order mark stays a character (readJsonMutation,
// where create-course.ts stripped it); an accepted answer counts as session
// activity after it is written and a failure of the touch is swallowed, as
// the profile route (Ductus counted awaited it). Who may do what is the RPC's.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import type { InstitutionCourses } from "../database/index.ts";
import { createInstitutionService } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const COURSES = ROUTES.find((route) => route.id === "institution.courses.post")!;
export const INSTITUTION_BODY_TIMEOUT_MS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type InstitutionCourseRouteOptions = {
  readonly courses: InstitutionCourses;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The refusal of each closed outcome; anything else is 503 unavailable. */
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["conflict", [409, "conflict"]],
  ["invalid", [422, "invalid_input"]],
  ["invalid_input", [422, "invalid_input"]],
]);

type Input = { readonly token: string; readonly value: unknown };

/**
 * Ductus readJsonMutation after the origin: the session token (401), every
 * path id a UUID (422), Content-Type exactly once of media type
 * application/json (415), the body under the limit and deadline, then strict
 * UTF-8 JSON (400). Refusals before the whole body was read close the
 * connection. Null when it already answered.
 */
async function readInstitutionJson(
  request: IncomingMessage,
  response: ServerResponse,
  ids: readonly string[],
  maxBytes: number,
  timeoutMs: number,
): Promise<Input | null> {
  const refused = (status: number, code: string): null => {
    refuse(response, status, code);
    return null;
  };
  const token = liveSessionTokenFromCookie(request.headers.cookie);
  if (token === undefined) return refused(401, "unauthorized");
  if (!ids.every((id) => UUID.test(id))) return refused(422, "invalid_input");
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return refused(415, "unsupported_media_type");
  }
  const body = await readBodyWithLimit(request, maxBytes, timeoutMs);
  if (!body.ok) return refused(body.status, body.reason);
  const json = parseJson(body.bytes);
  if (json.ok) return { token, value: json.value };
  sendProblem(response, 400, "invalid_json");
  return null;
}

/** The institution course routes over the service; 852-4b adds the enrolment code. */
export function createInstitutionCourseRoutes(options: InstitutionCourseRouteOptions): Route[] {
  const service = createInstitutionService({ courses: options.courses });
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;

  const coursesRoute: Route = {
    contract: COURSES,
    async handle(request, response) {
      const input = await readInstitutionJson(
        request,
        response,
        [],
        COURSES.request.maxBodyBytes ?? 2048,
        timeoutMs,
      );
      if (input === null) return;
      try {
        const outcome = await service.createCourse(input.token, input.value);
        if (outcome.status !== "created") {
          const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
          return sendProblem(response, status, code);
        }
        sendJson(response, 200, { id: outcome.id });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), COURSES.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted answer counts, once written; a failure costs only the touch.
      void options.recordActivity(input.token).catch(() => undefined);
    },
  };

  return [coursesRoute];
}
