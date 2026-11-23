import { Value } from "@sinclair/typebox/value";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../../contracts/index.ts";
import {
  createDeclarationRequirement,
  type DeclarationRequirement,
  type DeclarationRequirementOutcome,
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

// PIL-K-IZJAVA-SRV (declaration-v1 §6.7): the teacher's declaration requirement.
//   GET, PUT /api/v1/teacher/assignments/{assignmentId}/declaration-requirement
// The session decides who asks; institution.declaration_requirement and
// set_declaration_required decide whether the caller teaches the assignment.
// Everyone else, an unknown and a malformed assignment read the same 404
// (C-23). Every answer is checked against its contract before it leaves.
const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  const body = found?.responses.find((response) => response.status === 200)?.body;
  if (found === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { route: found, body };
};
const READ = contract("teacher.declaration-requirement.get");
const SET = contract("teacher.declaration-requirement.put");
type Contract = typeof READ;

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function answer(
  response: ServerResponse,
  { route, body: schema }: Contract,
  result: DeclarationRequirementOutcome,
): void {
  if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (result.status === "not_found") return sendProblem(response, 404, "not_found");
  if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
  if (result.status !== "ok") {
    reportServerError("route", new Error(result.status), requestIdOf(response), route.id);
    return sendProblem(response, 503, "unavailable");
  }
  const value = { required: result.required, changedAt: result.changedAt };
  if (!Value.Check(schema, value)) {
    reportServerError(
      "route",
      new Error("answer outside the contract"),
      requestIdOf(response),
      route.id,
    );
    return sendProblem(response, 503, "unavailable");
  }
  sendJson(response, 200, value);
}

/** The JSON body exactly as the contract says, or a refusal already sent. */
async function bodyOf(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<{ ok: true; required: boolean } | { ok: false }> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(request, SET.route.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  if (!Value.Check(SET.route.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return { ok: false };
  }
  return { ok: true, required: (json.value as { required: boolean }).required };
}

export function createDeclarationRequirementRoutes(port: DeclarationRequirement): Route[] {
  return [
    {
      contract: READ.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = params?.assignmentId;
        if (assignmentId === undefined || !UUID.test(assignmentId)) {
          return sendProblem(response, 404, "not_found");
        }
        answer(response, READ, await port.read(token, assignmentId));
      },
    },
    {
      contract: SET.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const parsed = await bodyOf(request, response);
        if (!parsed.ok) return;
        const assignmentId = params?.assignmentId;
        if (assignmentId === undefined || !UUID.test(assignmentId)) {
          return sendProblem(response, 404, "not_found");
        }
        answer(response, SET, await port.set(token, assignmentId, parsed.required));
      },
    },
  ];
}

export function createDeclarationRequirementRoutesFor({
  withActor,
}: {
  withActor: WithActor;
}): Route[] {
  return createDeclarationRequirementRoutes(createDeclarationRequirement(withActor));
}
