// SRV-F4-PM2-R15 (Ductus#2059; plan M5.14b, D-234): the HTTP edge of the plan of
// a work (work.plan.get, work.plan.put). The edge only, as mentorship-follow: a
// live session cookie (401), the work id decoded once by workIdFromPath (one that
// is not a work id is the same 404 as another's work, C-23), for the write the
// media type, the bounded body and its shape, then server/database/work-plan.
// The database decides who may (the student who owns the work); a refusal of the
// relation is 404, a malformed plan 422 and writes nothing. A throw is 503 and
// reported. The plan is never read against the document.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { isWorkId, workIdFromPath, workPlanRoutes, WorkPlanInput } from "../../contracts/index.ts";
import {
  createWorkPlanStore,
  type WithActor,
  type WorkPlanAnswer,
  type WorkPlanInput as PlanInput,
  type WorkPlanStore,
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

type Contract = (typeof workPlanRoutes)[number];

/** Answers a closed refusal of the port with its status and problem code. */
function refusalOf(
  response: ServerResponse,
  status: Exclude<WorkPlanAnswer["status"], "ok">,
): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  return sendProblem(response, 503, "unavailable");
}

type Body = { ok: true; value: unknown } | { ok: false };

/** Reads a JSON body under the contract's bound; on refusal the response is sent. */
async function jsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  contract: Contract,
): Promise<Body> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(
    request,
    (contract.request as { maxBodyBytes?: number }).maxBodyBytes ?? 0,
    BODY_TIMEOUT_MS,
  );
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  return { ok: true, value: json.value };
}

async function answer(
  response: ServerResponse,
  contract: Contract,
  call: () => Promise<WorkPlanAnswer>,
): Promise<void> {
  try {
    const result = await call();
    if (result.status === "ok") return sendJson(response, 200, result.plan);
    return refusalOf(response, result.status);
  } catch (error) {
    reportServerError("route", error, requestIdOf(response), contract.id);
    return sendProblem(response, 503, "unavailable");
  }
}

function routeFor(plans: WorkPlanStore, contract: Contract): Route {
  const write = contract.method !== "GET";
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) {
        return write
          ? refuse(response, 401, "unauthorized")
          : sendProblem(response, 401, "unauthorized");
      }
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return write ? refuse(response, 404, "not_found") : sendProblem(response, 404, "not_found");
      }
      if (contract.method === "GET") {
        return answer(response, contract, () => plans.read(token, documentId));
      }
      const body = await jsonBody(request, response, contract);
      if (!body.ok) return;
      if (!Value.Check(WorkPlanInput, body.value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const plan = body.value as PlanInput;
      return answer(response, contract, () => plans.write(token, documentId, plan));
    },
  };
}

/** The routes over a given port (tests use a fake port). */
export function createWorkPlanRoutes(plans: WorkPlanStore): Route[] {
  return workPlanRoutes.map((contract) => routeFor(plans, contract));
}

/** Both routes over main's application withActor. */
export function createWorkPlanRoutesFor(main: { withActor: WithActor }): Route[] {
  return createWorkPlanRoutes(createWorkPlanStore(main.withActor));
}
