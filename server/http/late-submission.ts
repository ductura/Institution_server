// PUT /api/v1/institution/assignments/{assignmentId}/late-submission and
// GET /api/v1/student/assignments/{assignmentId}/late-submission
// (SRV-NF4-KASNA-POLJE; contracts institution.assignment-late-submission.put
// and student.assignment-late-submission.get): the teacher of the assignment
// sets whether a submission after the deadline is allowed, a student of its
// course reads it. The session decides who asks, the database whether the
// relation holds; anyone else, an unknown and a malformed assignment read the
// same 404 (C-23). Every answer is checked against its contract before it
// leaves.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createLateSubmissionPort,
  type LateSubmissionPort,
  type LateSubmissionSetting,
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
const SET = contractOf("institution.assignment-late-submission.put");
const READ = contractOf("student.assignment-late-submission.get");

const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

/** The outcome of the port on the wire: 401, 404, 422, else the checked value. */
function send(
  response: ServerResponse,
  { contract, body }: typeof SET,
  result: LateSubmissionSetting,
): void {
  if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
  if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
  if (result.status !== "read") return sendProblem(response, 404, "not_found");
  const answer = { lateSubmissionAllowed: result.lateSubmissionAllowed };
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

export function createLateSubmissionRoutes(port: LateSubmissionPort): Route[] {
  return [
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
        const { lateSubmissionAllowed } = json.value as { lateSubmissionAllowed: boolean };
        await guarded(response, SET.contract.id, async () =>
          send(response, SET, await port.set(token, assignmentId, lateSubmissionAllowed)),
        );
      },
    },
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
  ];
}

/** The two routes over main's application withActor. */
export function createLateSubmissionRoutesFor(main: { withActor: WithActor }): Route[] {
  return createLateSubmissionRoutes(createLateSubmissionPort(main.withActor));
}
