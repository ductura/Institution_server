// POST /api/v1/institution/courses/{courseId}/assignments and
// POST /api/v1/institution/assignments/{assignmentId}/versions (SRV-14,
// Ductus#2028 c.7008147932; contracts institution.course-assignments.post and
// institution.assignment-versions.post). The HTTP edge of Ductus
// create-assignment.ts and assignment-version-route.ts at 078c780, in front of
// the same JSON reader as the course routes (readInstitutionJson: session,
// path ids, media type, body, JSON). Who may do what is the RPC's; the caller
// comes only from the session. Publishing sends nothing to anyone (C-17):
// students read the assignment in student.assignments.get.
import type { IncomingMessage } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import {
  type AssignmentCreateOutcome,
  type AssignmentPublishOutcome,
  createInstitutionAssignments,
  type InstitutionAssignments,
} from "../database/index.ts";
import { parseAssignmentInput, parseAssignmentVersionBody } from "../institution/index.ts";
import { recordActivity } from "../session/index.ts";

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

export type InstitutionAssignmentRouteOptions = {
  readonly assignments: InstitutionAssignments;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

type Outcome = AssignmentCreateOutcome | AssignmentPublishOutcome;
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["invalid", [422, "invalid_input"]],
  ["conflict", [409, "conflict"]],
  ["version_conflict", [409, "version_conflict"]],
] as const);

const contractOf = (id: string) => ROUTES.find((route) => route.id === id)!;

/** The one Idempotency-Key header as a UUID, or null for none, several or another form. */
function requestKeyOf(request: IncomingMessage): string | null {
  const keys = request.headersDistinct["idempotency-key"];
  return keys?.length === 1 && UUID.test(keys[0] ?? "") ? keys[0]!.toLowerCase() : null;
}

export function createInstitutionAssignmentRoutes(
  options: InstitutionAssignmentRouteOptions,
): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;

  const route = (
    id: string,
    param: string,
    run: (
      token: string,
      value: unknown,
      pathId: string,
      request: IncomingMessage,
    ) => Promise<Outcome | null>,
    answer: (outcome: Outcome, pathId: string) => Readonly<Record<string, unknown>> | null,
  ): Route => {
    const contract = contractOf(id);
    return {
      contract,
      async handle(request, response, params) {
        const pathId = decodeOnce(params?.[param]);
        const maxBytes = contract.request.maxBodyBytes ?? 64;
        const input = await readInstitutionJson(request, response, [pathId], maxBytes, timeoutMs);
        if (input === null) return;
        try {
          const outcome = await run(input.token, input.value, pathId, request);
          if (outcome === null) return sendProblem(response, 422, "invalid_input");
          const body = answer(outcome, pathId);
          if (body === null) {
            const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
            return sendProblem(response, status, code);
          }
          sendJson(response, 201, body);
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
    route(
      "institution.course-assignments.post",
      "courseId",
      async (token, value, courseId, request) => {
        const key = requestKeyOf(request);
        const content = parseAssignmentInput(value);
        if (key === null || content === null) return null;
        return options.assignments.createAssignment(token, courseId.toLowerCase(), key, content);
      },
      (outcome) => (outcome.status === "created" ? { id: outcome.id } : null),
    ),
    route(
      "institution.assignment-versions.post",
      "assignmentId",
      async (token, value, assignmentId) => {
        const body = parseAssignmentVersionBody(value);
        if (body === null) return null;
        return options.assignments.publishVersion(
          token,
          assignmentId.toLowerCase(),
          body.expectedVersion,
          body.content,
        );
      },
      (outcome, assignmentId) =>
        outcome.status === "published"
          ? { assignmentId: assignmentId.toLowerCase(), versionNo: outcome.versionNo }
          : null,
    ),
  ];
}

/** Both routes over main's application withActor; server/server.ts mounts them. */
export function createInstitutionAssignmentRoutesFor(
  main: Pick<Databases["main"], "withActor">,
): Route[] {
  return createInstitutionAssignmentRoutes({
    assignments: createInstitutionAssignments(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
