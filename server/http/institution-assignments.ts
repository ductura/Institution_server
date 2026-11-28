// POST /api/v1/institution/courses/{courseId}/assignments and
// POST /api/v1/institution/assignments/{assignmentId}/versions (SRV-14,
// Ductus#2028 c.7008147932; contracts institution.course-assignments.post and
// institution.assignment-versions.post). The HTTP edge of Ductus
// create-assignment.ts and assignment-version-route.ts at 078c780 (the
// creation's retry key is requestKey in the body, not an Idempotency-Key
// header, so the generated client sends it), in front of
// the same JSON reader as the course routes (readInstitutionJson: session,
// path ids, media type, body, JSON). Who may do what is the RPC's; the caller
// comes only from the session. Publishing sends nothing to anyone (C-17):
// students read the assignment in student.assignments.get.
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

/** {requestKey, ...content}: the key as a lower-case UUID and the rest as the content, or null. */
/** An optional boolean of the body: absent is false, anything but a boolean is null. */
const optionalFlag = (body: object, key: string, value: unknown): boolean | null =>
  !Object.hasOwn(body, key) ? false : typeof value === "boolean" ? value : null;

/**
 * The optional documentKind (SRV-V13-VRSTA-POST) and workKind (SRV-V14-KIND-ENUM): both
 * absent is "text", as in the reads. workKind wins over documentKind; both present and
 * different is the 422 of the contract, as is anything but a known kind. No RPC stores
 * another kind yet (institution.assignment.document_kind has no writer, SRV-V13-MIG-VRSTA),
 * so "slides" and "spreadsheet" are refused too rather than made into a text assignment
 * in silence.
 */
const KINDS_STORED: ReadonlySet<unknown> = new Set(["text"]);
function withoutDocumentKind(value: unknown): { fields: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { fields: value };
  const { documentKind, workKind, ...fields } = value as Record<string, unknown>;
  const hasDocumentKind = Object.hasOwn(value, "documentKind");
  const hasWorkKind = Object.hasOwn(value, "workKind");
  if (hasDocumentKind && hasWorkKind && documentKind !== workKind) return null;
  const kind = hasWorkKind ? workKind : documentKind;
  if ((hasDocumentKind || hasWorkKind) && !KINDS_STORED.has(kind)) return null;
  return { fields };
}

function parseCreateBody(raw: unknown) {
  const stripped = withoutDocumentKind(raw);
  if (stripped === null) return null;
  const value = stripped.fields;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { requestKey, isPractice, externalToolsAllowed, aiSummaryOnly, groupIds, ...fields } =
    value as Record<string, unknown>;
  if (typeof requestKey !== "string" || !UUID.test(requestKey)) return null;
  const practice = optionalFlag(value, "isPractice", isPractice);
  const tools = optionalFlag(value, "externalToolsAllowed", externalToolsAllowed);
  const summaryOnly = optionalFlag(value, "aiSummaryOnly", aiSummaryOnly);
  if (practice === null || tools === null || summaryOnly === null) return null;
  const groups = parseGroupIds(value, groupIds);
  if (groups === null) return null;
  const content = parseAssignmentInput(fields);
  if (content === null) return null;
  // The contract's 422: summary only under a prohibited policy or with any purpose.
  if (summaryOnly && (content.aiPolicy === "prohibited" || content.aiPurposes.length > 0)) {
    return null;
  }
  return {
    key: requestKey.toLowerCase(),
    content,
    isPractice: practice,
    setup: { externalToolsAllowed: tools, aiSummaryOnly: summaryOnly },
    groupIds: groups,
  };
}

/**
 * The optional groupIds (F4 wave 2 #5, 1.8): absent or empty is the whole
 * course, as before; otherwise at most 20 UUIDs, each once in any case, in
 * lower case. Whether each is a group of the course is the database's
 * (add_assignment_groups, ZD422). Null is the contract's 422.
 */
const MAX_GROUPS = 20;
function parseGroupIds(body: object, groupIds: unknown): string[] | null {
  if (!Object.hasOwn(body, "groupIds")) return [];
  if (!Array.isArray(groupIds) || groupIds.length > MAX_GROUPS) return null;
  if (!groupIds.every((id): id is string => typeof id === "string" && UUID.test(id))) return null;
  const lower = groupIds.map((id) => id.toLowerCase());
  return new Set(lower).size === lower.length ? lower : null;
}

export function createInstitutionAssignmentRoutes(
  options: InstitutionAssignmentRouteOptions,
): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;

  const route = (
    id: string,
    param: string,
    run: (token: string, value: unknown, pathId: string) => Promise<Outcome | null>,
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
          const outcome = await run(input.token, input.value, pathId);
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
      async (token, value, courseId) => {
        const body = parseCreateBody(value);
        if (body === null) return null;
        return options.assignments.createAssignment(
          token,
          courseId.toLowerCase(),
          body.key,
          body.content,
          body.isPractice,
          body.setup,
          body.groupIds,
        );
      },
      (outcome) => (outcome.status === "created" ? { id: outcome.id } : null),
    ),
    route(
      "institution.assignment-versions.post",
      "assignmentId",
      async (token, value, assignmentId) => {
        const stripped = withoutDocumentKind(value);
        if (stripped === null) return null;
        const body = parseAssignmentVersionBody(stripped.fields);
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
