// SRV-V17-TEMPLATE-ASSIGN: the HTTP edge of the work template of an assignment. Who may is the
// database's (teacher of the course for the switch, student of the course for the read); the
// caller comes from the session, the assignment from the path. A malformed, foreign, unknown or
// template-less id is the same 404 (C-23); a body or query outside the contract is 422; an
// answer outside the contract, or a throw, is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { assignmentTemplateRoutes, AssignmentTemplateInput } from "../../contracts/index.ts";
import { createAssignmentTemplate, type WithActor } from "../../database/index.ts";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function createAssignmentTemplateRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createAssignmentTemplate(main.withActor);
  return assignmentTemplateRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        try {
          const answer = await respond(token);
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
          return sendJson(response, 200, answer.body);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }

        /** undefined: the problem is already sent. */
        async function respond(sessionToken: string): Promise<{ body: unknown } | undefined> {
          if (contract.id === "student.assignment-template.get") {
            const target = request.url ?? "";
            const queryAt = target.indexOf("?");
            if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
              sendProblem(response, 422, "invalid_input");
              return undefined;
            }
            const assignmentId = params?.assignmentId ?? "";
            if (!UUID.test(assignmentId)) {
              sendProblem(response, 404, "not_found");
              return undefined;
            }
            const result = await store.read(sessionToken, assignmentId.toLowerCase());
            switch (result.status) {
              case "found":
                return { body: result.template };
              case "unauthorized":
                sendProblem(response, 401, "unauthorized");
                return undefined;
              case "invalid_input":
                sendProblem(response, 422, "invalid_input");
                return undefined;
              default:
                // no_template, not_found and conflict (not reachable) are one answer.
                sendProblem(response, 404, "not_found");
                return undefined;
            }
          }

          const types = request.headersDistinct["content-type"];
          if (
            types?.length !== 1 ||
            types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
          ) {
            refuse(response, 415, "unsupported_media_type");
            return undefined;
          }
          const raw = await readBodyWithLimit(
            request,
            contract.request.maxBodyBytes!,
            BODY_TIMEOUT_MS,
          );
          if (!raw.ok) {
            refuse(response, raw.status, raw.reason);
            return undefined;
          }
          const json = parseJson(raw.bytes);
          if (!json.ok) {
            sendProblem(response, 400, "invalid_json");
            return undefined;
          }
          if (!Value.Check(AssignmentTemplateInput, json.value)) {
            sendProblem(response, 422, "invalid_input");
            return undefined;
          }
          const assignmentId = params?.assignmentId ?? "";
          if (!UUID.test(assignmentId)) {
            sendProblem(response, 404, "not_found");
            return undefined;
          }
          const use = json.value.useInstitutionTemplate;
          const result = await store.set(sessionToken, assignmentId.toLowerCase(), use);
          switch (result.status) {
            case "set":
              return { body: { useInstitutionTemplate: use, version: result.version } };
            case "unauthorized":
              sendProblem(response, 401, "unauthorized");
              return undefined;
            case "not_found":
              sendProblem(response, 404, "not_found");
              return undefined;
            case "conflict":
              sendProblem(response, 409, "conflict");
              return undefined;
            case "invalid_input":
              sendProblem(response, 422, "invalid_input");
              return undefined;
          }
        }
      },
    };
  });
}
