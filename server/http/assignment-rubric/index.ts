// SRV-V17-RUBRIC-DEF (Ductus#2055, val 17): the HTTP edge of the rubric of an assignment. A
// teacher of the assignment reads it and adds a version; a student of the assignment reads it
// (the six default criteria while none is set). Who may is the database's; the institution, the
// author and the assignment come from the session and the path, never from the body. Everyone
// without a part in the assignment, another institution, an unknown and a malformed id are the
// same 404; input outside the contract is 422, a stale expectedVersion is 409, an answer outside
// the contract or a throw is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { AssignmentRubricInput, assignmentRubricRoutes } from "../../contracts/index.ts";
import {
  createAssignmentRubric,
  type RubricCriterion,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const ERRORS = new Map<unknown, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD404", [404, "not_found"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

export function createAssignmentRubricRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createAssignmentRubric(main.withActor);
  return assignmentRubricRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const assignmentId = params?.assignmentId ?? "";
        if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
        try {
          let body: unknown;
          if (contract.id === "teacher.assignment-rubric.get") {
            body = await store.forTeacher(token, assignmentId);
          } else if (contract.id === "student.assignment-rubric.get") {
            body = await store.forStudent(token, assignmentId);
          } else {
            const json = await jsonBody(request, response, contract.request.maxBodyBytes!);
            if (json === undefined) return;
            if (!Value.Check(AssignmentRubricInput, json)) {
              return sendProblem(response, 422, "invalid_input");
            }
            const sent = json as { expectedVersion: number; criteria: RubricCriterion[] };
            body = await store.publish(token, assignmentId, sent.expectedVersion, sent.criteria);
          }
          if (success.body !== undefined && !Value.Check(success.body, body)) {
            reportServerError(
              "route",
              new Error("answer outside the contract"),
              requestIdOf(response),
              contract.id,
            );
            return sendProblem(response, 503, "unavailable");
          }
          return sendJson(response, 200, body);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = ERRORS.get(code);
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    };
  });
}

async function jsonBody(
  req: Parameters<Route["handle"]>[0],
  res: Parameters<Route["handle"]>[1],
  limit: number,
): Promise<unknown> {
  const types = req.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
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
