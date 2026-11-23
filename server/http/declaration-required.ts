// GET and PUT /api/v1/teacher/assignments/{assignmentId}/declaration-required
// (PIL-K-IZJAVA-SRV; contracts teacher.declaration-required.get and .put):
// the teacher of the assignment reads and sets whether a submission requires
// a declaration confirmed for the submitted revision. The session decides who
// asks; institution.declaration_required_setting and set_declaration_required
// decide whether the caller teaches the assignment. A student, another
// teacher, an unknown and a malformed assignment read the same 404 (C-23).
// Every answer is checked against its contract before it leaves.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createDeclarationRequiredSwitch,
  type DeclarationRequiredSetting,
  type DeclarationRequiredSwitch,
  type WithActor,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}
const READ = contractOf("teacher.declaration-required.get");
const SET = contractOf("teacher.declaration-required.put");

const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

/** The outcome of the port on the wire: 401, 404, 422, else the checked switch. */
function send(
  response: ServerResponse,
  { contract, body }: typeof READ,
  result: DeclarationRequiredSetting,
): void {
  if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
  if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
  if (result.status !== "read") return sendProblem(response, 404, "not_found");
  const answer = { required: result.required, changedAt: result.changedAt };
  if (Value.Check(body, answer)) return sendJson(response, 200, answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  sendProblem(response, 503, "unavailable");
}

async function guarded(
  response: ServerResponse,
  id: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  }
}

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

export function createDeclarationRequiredRoutes(port: DeclarationRequiredSwitch): Route[] {
  return [
    {
      contract: READ.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = idOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        await guarded(response, READ.contract.id, async () =>
          send(response, READ, await port.read(token, assignmentId)),
        );
      },
    },
    {
      contract: SET.contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          SET.contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(SET.contract.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const assignmentId = idOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        const { required } = json.value as { required: boolean };
        await guarded(response, SET.contract.id, async () =>
          send(response, SET, await port.set(token, assignmentId, required)),
        );
      },
    },
  ];
}

/** The two routes over main's application withActor. */
export function createDeclarationRequiredRoutesFor(main: { withActor: WithActor }): Route[] {
  return createDeclarationRequiredRoutes(createDeclarationRequiredSwitch(main.withActor));
}
