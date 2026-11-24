// SRV-V17-TEMPLATE-ADMIN: the HTTP edge of the work template of an institution, one per work
// type (administrator only). Who may is the database's; the institution and the author come
// from the session, the work type from the path, never from the body. A teacher or a student is
// 403, input outside the contract or an unknown work type is 422, a stale expectedVersion is 409,
// an answer outside the contract or a throw is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { WorkTemplateInput, WorkTemplateType, workTemplateRoutes } from "../../contracts/index.ts";
import { createWorkTemplate, type WithActor } from "../../database/index.ts";
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
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

export function createWorkTemplateRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createWorkTemplate(main.withActor);
  return workTemplateRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        try {
          const answer = await respond(token, request, response, params);
          if (answer === undefined) return;
          if (!Value.Check(success.body, answer.body)) {
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
          const workType = pathParams?.workType;
          if (!Value.Check(WorkTemplateType, workType)) {
            sendProblem(res, 422, "invalid_input");
            return undefined;
          }
          if (contract.id === "institution.work-template.get") {
            const target = req.url ?? "";
            const queryAt = target.indexOf("?");
            if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
              sendProblem(res, 422, "invalid_input");
              return undefined;
            }
            const versions = await store.versions(sessionToken, workType);
            return { status: 200, body: { current: versions.at(-1) ?? null, versions } };
          }

          const types = req.headersDistinct["content-type"];
          if (
            types?.length !== 1 ||
            types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
          ) {
            refuse(res, 415, "unsupported_media_type");
            return undefined;
          }
          const raw = await readBodyWithLimit(req, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
          if (!raw.ok) {
            refuse(res, raw.status, raw.reason);
            return undefined;
          }
          const parsed = parseJson(raw.bytes);
          if (!parsed.ok) {
            sendProblem(res, 400, "invalid_json");
            return undefined;
          }
          if (!Value.Check(WorkTemplateInput, parsed.value)) {
            sendProblem(res, 422, "invalid_input");
            return undefined;
          }
          const sent = parsed.value;
          const version = await store.publish(sessionToken, workType, sent.expectedVersion, sent);
          // The version is stored and never changes: its moment comes from the chain.
          const stored = (await store.versions(sessionToken, workType)).find(
            (v) => v.version === version,
          );
          if (stored === undefined) throw new Error("published work template not found");
          return { status: 200, body: stored };
        }
      },
    };
  });
}
