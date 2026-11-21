// The teacher’s course, access, mentorship and submission reads. The route
// takes the session token from the cookie. The database decides which rows
// that session can read. The POST accepts a batch of assignment IDs.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import {
  type AssignmentSubmissionsReader,
  createAssignmentSubmissionsReader,
  createMentoredWorksReader,
  createTeacherAccessReader,
  type MentoredWorksReader,
  createTeacherCoursesReader,
  createTeacherSubmissions,
  type TeacherAccessReader,
  type TeacherCoursesReader,
  type TeacherSubmissions,
} from "../database/index.ts";
import { liveSessionTokenFromCookie, principalScope } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { INSTITUTION_BODY_TIMEOUT_MS, readInstitutionJson } from "./institution-courses.ts";
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

export type TeacherReadOptions = {
  readonly mentored: MentoredWorksReader;
  readonly submissions: AssignmentSubmissionsReader;
  readonly submissionList: TeacherSubmissions["list"];
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The largest list of one POST (the contract's maxItems). */
export const MAX_ASSIGNMENT_IDS = 500;
const ANY_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The status of a read's failure; anything not named here is 503. */
const FAILURE: ReadonlyMap<unknown, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["not_found", [404, "not_found"]],
]);

type Read = (
  token: string,
  params: Readonly<Record<string, string>> | undefined,
) => Promise<
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: unknown }
>;

/**
 * A GET read: Sec-Fetch-Site, when sent, exactly one same-origin (403), then a
 * live session cookie (401), then the read. A throw is 503 and reported.
 */
function getRoute(id: string, read: Read): Route {
  const routeContract = contract(id);
  return {
    contract: routeContract,
    async handle(request, response, params) {
      const token = tokenOf(request, response);
      if (token === undefined) return;
      try {
        const answer = await read(token, params);
        if (answer.ok) return sendJson(response, 200, answer.body);
        const known = FAILURE.get(answer.status);
        const [status, code] = known ?? [503, "unavailable"];
        return sendProblem(response, status, code);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), routeContract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** Exactly {assignmentIds}: an array of at most 500 UUIDs in any case; anything else is null. */
export function parseAssignmentIdsBody(value: unknown): readonly string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(value, "assignmentIds")) return null;
  const ids = (value as { assignmentIds: unknown }).assignmentIds;
  if (!Array.isArray(ids) || ids.length > MAX_ASSIGNMENT_IDS) return null;
  return ids.every((id) => typeof id === "string" && ANY_CASE_UUID.test(id))
    ? [...(ids as string[])]
    : null;
}

export function createTeacherReadRoutes(options: TeacherReadOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  const many = contract("teacher.assignment-submissions.post");
  return [
    getRoute("teacher.mentorships.get", async (token) => {
      const read = await options.mentored.readMentoredWorks(token);
      return read.status === "ok"
        ? { ok: true, body: { works: read.works } }
        : { ok: false, status: read.status };
    }),
    getRoute("teacher.mentorship.get", async (token, params) => {
      // Decoded once; a malformed id is the same 404 as any other (the port's).
      const mentorshipId = workIdFromPath(params?.mentorshipId ?? "") ?? "";
      const read = await options.mentored.readMentoredWork(token, mentorshipId);
      return read.status === "ok"
        ? { ok: true, body: { work: read.work } }
        : { ok: false, status: read.status };
    }),
    getRoute("teacher.submissions.get", async (token, params) => {
      const assignmentId = workIdFromPath(params?.assignmentId ?? "") ?? "";
      const read = await options.submissionList(token, assignmentId);
      return read.status === "ok"
        ? { ok: true, body: read.body }
        : { ok: false, status: read.status };
    }),
    {
      contract: many,
      async handle(request, response) {
        const maxBytes = many.request.maxBodyBytes ?? 64;
        const input = await readInstitutionJson(request, response, [], maxBytes, timeoutMs);
        if (input === null) return;
        const ids = parseAssignmentIdsBody(input.value);
        if (ids === null) return sendProblem(response, 422, "invalid_input");
        try {
          const read = await options.submissions(input.token, ids);
          if (read.status !== "ok") {
            const known = FAILURE.get(read.status);
            const [status, code] = known ?? [503, "unavailable"];
            return sendProblem(response, status, code);
          }
          // One entry per distinct lower-case id, in the order of first appearance.
          const assignments = [...read.submissions].map(([assignmentId, submissions]) => ({
            assignmentId,
            submissions,
          }));
          sendJson(response, 200, { assignments });
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), many.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}

/** All teacher reads over main's application withActor. */
export function createTeacherReadRoutesFor(main: Pick<Databases["main"], "withActor">): Route[] {
  return [
    createTeacherCoursesRoute(createTeacherCoursesReader(main.withActor)),
    createTeacherAccessRoute(createTeacherAccessReader(main.withActor)),
    ...createTeacherReadRoutes({
      mentored: createMentoredWorksReader(main.withActor),
      submissions: createAssignmentSubmissionsReader(main.withActor),
      submissionList: createTeacherSubmissions(main.withActor).list,
    }),
  ];
}
