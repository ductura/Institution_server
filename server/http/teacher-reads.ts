// The teacher's reads (contracts teacher.courses.get, teacher.mentorships.get,
// teacher.mentorship.get, teacher.submissions.get and
// teacher.assignment-submissions.post). Port of the HTTP edge of Ductus
// teacher-courses.ts (handleTeacherCoursesRequest), mentored-works.ts
// (guard, handleMentoredWorksRequest, handleMentoredWorkRequest) and
// assignment-submissions.ts (handleAssignmentSubmissionsRequest) at 078c780,
// over the database ports of server/database. Changes: the token is
// liveSessionTokenFromCookie, as profile-me.ts; a GET answers 403 for
// Sec-Fetch-Site other than one same-origin, as Ductus guard; the method is
// the router's (405). The POST of many assignments has no Ductus route
// (DAN-903-1, Ductus 4eaa776 reads it in its teacher page): its body is
// exactly {assignmentIds}, 0 to 500 UUIDs in any case, behind the institution
// front (readInstitutionJson). Each read answers for all of its rows: a row a
// port cannot vouch for makes the whole answer 503. Nothing here writes.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import {
  type AssignmentSubmissionsReader,
  createAssignmentSubmissionsReader,
  createMentoredWorksReader,
  createTeacherCoursesReader,
  type MentoredWorksReader,
  type TeacherCoursesReader,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { INSTITUTION_BODY_TIMEOUT_MS, readInstitutionJson } from "./institution-courses.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

export type TeacherReadOptions = {
  readonly courses: TeacherCoursesReader;
  readonly mentored: MentoredWorksReader;
  readonly submissions: AssignmentSubmissionsReader;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The largest list of one POST (the contract's maxItems). */
export const MAX_ASSIGNMENT_IDS = 500;
const ANY_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const contractOf = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};

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
  const contract = contractOf(id);
  return {
    contract,
    async handle(request: IncomingMessage, response: ServerResponse, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const answer = await read(token, params);
        if (answer.ok) return sendJson(response, 200, answer.body);
        const known = FAILURE.get(answer.status);
        const [status, code] = known ?? [503, "unavailable"];
        return sendProblem(response, status, code);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
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
  const many = contractOf("teacher.assignment-submissions.post");
  return [
    getRoute("teacher.courses.get", async (token) => {
      const read = await options.courses(token);
      return read.status === "ok"
        ? { ok: true, body: { courses: read.courses } }
        : { ok: false, status: read.status };
    }),
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
      // Ductus: a malformed id is the same empty list as any refusal, without asking.
      const assignmentId = workIdFromPath(params?.assignmentId ?? "") ?? "";
      const read = await options.submissions(token, [assignmentId]);
      return read.status === "ok"
        ? {
            ok: true,
            body: { submissions: read.submissions.get(assignmentId.toLowerCase()) ?? [] },
          }
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

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createTeacherReadRoutesFor(main: Pick<Databases["main"], "withActor">): Route[] {
  return createTeacherReadRoutes({
    courses: createTeacherCoursesReader(main.withActor),
    mentored: createMentoredWorksReader(main.withActor),
    submissions: createAssignmentSubmissionsReader(main.withActor),
  });
}
