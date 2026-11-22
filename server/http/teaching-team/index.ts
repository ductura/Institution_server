import { Value } from "@sinclair/typebox/value";

import { teachingTeamRoutes } from "../../contracts/index.ts";
import { createTeachingTeam, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  INSTITUTION_BODY_TIMEOUT_MS,
  decodeOnce,
  readInstitutionJson,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const [READ_TEAM, READ_VIEW, REPLACE_TEAM, REPLACE_GROUP] = teachingTeamRoutes;
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

function uniqueIds(ids: string[]): boolean {
  return new Set(ids.map((id) => id.toLowerCase())).size === ids.length;
}

export function createTeachingTeamRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const team = createTeachingTeam(withActor);

  return teachingTeamRoutes.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const courseId = decodeOnce(params?.id);
      const groupId = decodeOnce(params?.groupId);
      try {
        if (contract.id === READ_TEAM.id || contract.id === READ_VIEW.id) {
          const site = request.headersDistinct["sec-fetch-site"];
          if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
            return sendProblem(response, 403, "forbidden");
          }
          const token = liveSessionTokenFromCookie(request.headers.cookie);
          if (token === undefined) return sendProblem(response, 401, "unauthorized");
          if (!Value.Check(READ_TEAM.request.params, { id: courseId })) {
            return sendProblem(response, 422, "invalid_input");
          }
          if (contract.id === READ_VIEW.id) {
            const view = await team.readView(token, courseId);
            if (!Value.Check(READ_VIEW.responses[0].body, view)) {
              throw new Error("Invalid teaching team view answer");
            }
            return sendJson(response, 200, view);
          }
          const result = await team.read(token, courseId);
          if (!Value.Check(READ_TEAM.responses[0].body, result)) {
            throw new Error("Invalid teaching team answer");
          }
          return sendJson(response, 200, result);
        }

        const input = await readInstitutionJson(
          request,
          response,
          contract.id === REPLACE_GROUP.id ? [courseId, groupId] : [courseId],
          contract.request.maxBodyBytes,
          INSTITUTION_BODY_TIMEOUT_MS,
        );
        if (input === null) return;
        if (contract.id === REPLACE_TEAM.id) {
          if (
            !Value.Check(REPLACE_TEAM.request.body, input.value) ||
            !uniqueIds(input.value.assistantIds)
          ) {
            return sendProblem(response, 422, "invalid_input");
          }
          await team.replaceAssistants(input.token, courseId, input.value.assistantIds);
        } else {
          if (
            !Value.Check(REPLACE_GROUP.request.body, input.value) ||
            !uniqueIds(input.value.assistantIds) ||
            !uniqueIds(input.value.studentIds)
          ) {
            return sendProblem(response, 422, "invalid_input");
          }
          await team.replaceGroup(
            input.token,
            courseId,
            groupId,
            input.value.assistantIds,
            input.value.studentIds,
          );
        }
        sendJson(response, 200, { updated: true });
        void recordActivity(input.token, withActor).catch(() => undefined);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  }));
}
