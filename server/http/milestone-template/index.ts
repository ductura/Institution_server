// SRV-1521 (Ductus#2052, N-15 etape): the HTTP edge of the template of milestones of an
// institution (administrator) and of the plan of milestones of one work (mentor adds, applies
// the template again; the owner and the teachers read). Who may is the database's; the
// institution, the author and the document come from the session and the path, never from
// the body. A teacher or a student on the administrator's routes is 403, input outside the
// contract is 422, a stale expectedVersion or a refused change is 409, an answer outside the
// contract or a throw is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import {
  MilestoneTemplateInput,
  milestoneTemplateRoutes,
  workIdFromPath,
  WorkMilestoneAddInput,
} from "../../contracts/index.ts";
import {
  createMilestoneTemplate,
  type MilestoneTemplateItem,
  type WithActor,
} from "../../database/index.ts";
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

const BODY_TIMEOUT_MS = 5_000;

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

export function createMilestoneTemplateRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createMilestoneTemplate(main.withActor);
  return milestoneTemplateRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        try {
          const answer = await respond(token, request, response, params);
          if (answer === undefined) return;
          if (success.body !== undefined && !Value.Check(success.body, answer.body)) {
            reportServerError(
              "route",
              new Error("answer outside the contract"),
              requestIdOf(response),
              contract.id,
            );
            return sendProblem(response, 503, "unavailable");
          }
          return sendJson(response, answer.status, answer.body);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = ERRORS.get(code);
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }

        async function respond(
          sessionToken: string,
          req: Parameters<Route["handle"]>[0],
          res: Parameters<Route["handle"]>[1],
          pathParams: Parameters<Route["handle"]>[2],
        ): Promise<{ status: number; body: unknown } | undefined> {
          if (contract.id === "institution.milestone-template.get") {
            const target = req.url ?? "";
            const queryAt = target.indexOf("?");
            if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
              sendProblem(res, 422, "invalid_input");
              return undefined;
            }
            const versions = await store.versions(sessionToken);
            return { status: 200, body: { current: versions.at(-1) ?? null, versions } };
          }

          if (contract.id === "institution.milestone-template.put") {
            const json = await jsonBody(req, res, contract.request.maxBodyBytes!);
            if (json === undefined) return undefined;
            if (!Value.Check(MilestoneTemplateInput, json)) {
              sendProblem(res, 422, "invalid_input");
              return undefined;
            }
            const sent = json as {
              expectedVersion: number;
              requireFinalStageApproval: boolean;
              milestones: MilestoneTemplateItem[];
            };
            const version = await store.publish(
              sessionToken,
              sent.expectedVersion,
              sent.requireFinalStageApproval,
              sent.milestones,
            );
            // The version is stored and never changes: its moment comes from the chain.
            const stored = (await store.versions(sessionToken)).find((v) => v.version === version);
            if (stored === undefined) throw new Error("published milestone template not found");
            return { status: 200, body: stored };
          }

          const documentId = workIdFromPath(pathParams?.documentId ?? "");
          if (documentId === null) {
            refuse(res, 404, "not_found");
            return undefined;
          }
          if (contract.id === "work.milestone-plan.get") {
            return {
              status: 200,
              body: { milestones: await store.plan(sessionToken, documentId) },
            };
          }
          if (contract.id === "work.milestone-plan.apply-template.post") {
            const empty = await readBodyWithLimit(req, 0, BODY_TIMEOUT_MS);
            if (!empty.ok) {
              refuse(res, empty.status, empty.reason);
              return undefined;
            }
            return {
              status: 200,
              body: { milestones: await store.applyTemplate(sessionToken, documentId) },
            };
          }
          const json = await jsonBody(req, res, contract.request.maxBodyBytes!);
          if (json === undefined) return undefined;
          if (!Value.Check(WorkMilestoneAddInput, json)) {
            sendProblem(res, 422, "invalid_input");
            return undefined;
          }
          return {
            status: 201,
            body: { milestones: await store.add(sessionToken, documentId, json) },
          };
        }

        async function jsonBody(
          req: Parameters<Route["handle"]>[0],
          res: Parameters<Route["handle"]>[1],
          limit: number,
        ): Promise<unknown> {
          const types = req.headersDistinct["content-type"];
          if (
            types?.length !== 1 ||
            types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
          ) {
            refuse(res, 415, "unsupported_media_type");
            return undefined;
          }
          const raw = await readBodyWithLimit(req, limit, BODY_TIMEOUT_MS);
          if (!raw.ok) {
            refuse(res, raw.status, raw.reason);
            return undefined;
          }
          const parsed = parseJson(raw.bytes);
          if (!parsed.ok) {
            sendProblem(res, 400, "invalid_json");
            return undefined;
          }
          return parsed.value;
        }
      },
    };
  });
}
