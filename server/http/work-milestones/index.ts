import { Value } from "@sinclair/typebox/value";

import {
  workIdFromPath,
  WorkMilestoneApprovalInput,
  WorkMilestoneChangeInput,
  WorkMilestoneDueInput,
  WorkMilestoneId,
  WorkMilestoneRevisionInput,
  workMilestonesRoutes,
} from "../../contracts/index.ts";
import { createWorkMilestones, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const ERRORS = new Map<unknown, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD404", [404, "not_found"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
  ["22007", [422, "invalid_input"]],
  ["22008", [422, "invalid_input"]],
  ["22009", [422, "invalid_input"]],
]);

export function createWorkMilestonesRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createWorkMilestones(main.withActor);
  return workMilestonesRoutes.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return refuse(response, 404, "not_found");
      try {
        if (contract.id === "work.milestones.get") {
          return sendJson(response, 200, { milestones: await store.list(token, documentId) });
        }
        if (contract.id === "work.milestone-states.get") {
          return sendJson(response, 200, { milestones: await store.listStates(token, documentId) });
        }

        const milestoneId = workIdFromPath(params?.milestoneId ?? "");
        if (!Value.Check(WorkMilestoneId, milestoneId)) return refuse(response, 404, "not_found");
        if (contract.request.maxBodyBytes === 0) {
          const empty = await readBodyWithLimit(request, 0, 5_000);
          if (!empty.ok) return refuse(response, empty.status, empty.reason);
          if (contract.method === "DELETE") {
            await store.remove(token, documentId, milestoneId);
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
            return;
          }
          return sendJson(response, 200, await store.submit(token, documentId, milestoneId));
        }
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, 5_000);
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (contract.id === "work.milestones.request-revision.post") {
          if (!Value.Check(WorkMilestoneRevisionInput, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          const { comment, revisionDueAt } = json.value;
          return sendJson(
            response,
            200,
            await store.requestRevision(token, documentId, milestoneId, comment, revisionDueAt),
          );
        }
        if (contract.id === "work.milestones.approve.post") {
          if (!Value.Check(WorkMilestoneApprovalInput, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          return sendJson(
            response,
            200,
            await store.approve(token, documentId, milestoneId, json.value.message),
          );
        }
        if (contract.id === "work.milestones.details.patch") {
          if (!Value.Check(WorkMilestoneChangeInput, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          return sendJson(
            response,
            200,
            await store.change(token, documentId, milestoneId, json.value),
          );
        }
        if (!Value.Check(WorkMilestoneDueInput, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const updated = await store.changeDueAt(token, documentId, milestoneId, json.value.dueAt);
        return sendJson(response, 200, updated);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = ERRORS.get(code);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  }));
}
