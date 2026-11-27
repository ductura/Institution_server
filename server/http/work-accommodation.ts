// GET and PUT /api/v1/student/assignments/{assignmentId}/accommodation and
// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/accommodation
// (F4-PM2-R08-SRV; contracts student.accommodation.get and .put,
// teacher.student-accommodation.get): the accommodation mark of one work (D-50),
// a yes or no. The edge only, as declaration-required.ts: a GET is
// same-origin or carries no Sec-Fetch-Site (403), then a live session (401);
// origin and Sec-Fetch-Site of the PUT are pipeline step 7. The database
// decides who may (server/institution/work-accommodation.ts). No log line
// carries the mark; every answer is checked against its contract.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import {
  readOwnWorkAccommodation,
  readWorkAccommodation,
  setWorkAccommodation,
  type WorkAccommodationRead,
  type WorkAccommodationWrite,
} from "../institution/index.ts";
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

export type WorkAccommodationPort = {
  readOwn(token: string, assignmentId: string): Promise<WorkAccommodationRead>;
  read(token: string, assignmentId: string, studentId: string): Promise<WorkAccommodationRead>;
  set(token: string, assignmentId: string, marked: boolean): Promise<WorkAccommodationWrite>;
};

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}
const OWN = contractOf("student.accommodation.get");
const SET = contractOf("student.accommodation.put");
const HOLDER = contractOf("teacher.student-accommodation.get");

const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

const WRITE_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  unauthorized: [401, "unauthorized"],
  forbidden: [403, "forbidden"],
  conflict: [409, "conflict"],
  invalidInput: [422, "invalid_input"],
};

/** The mark on the wire, or 503 for an answer outside the contract. */
function sendMark(response: ServerResponse, { contract, body }: typeof OWN, marked: boolean) {
  const answer = { marked };
  if (Value.Check(body, answer)) return sendJson(response, 200, answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  sendProblem(response, 503, "unavailable");
}

function sendRead(response: ServerResponse, route: typeof OWN, read: WorkAccommodationRead) {
  if (read.kind === "notFound") return sendProblem(response, 404, "not_found");
  if (read.kind !== "ok") return sendProblem(response, 503, "unavailable");
  sendMark(response, route, read.marked);
}

async function guarded(response: ServerResponse, id: string, run: () => Promise<void>) {
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

export function createWorkAccommodationRoutes(port: WorkAccommodationPort): Route[] {
  return [
    {
      contract: OWN.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = idOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        await guarded(response, OWN.contract.id, async () =>
          sendRead(response, OWN, await port.readOwn(token, assignmentId)),
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
        // A malformed id is the same refusal as another's assignment (C-23).
        const assignmentId = idOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 403, "forbidden");
        const { marked } = json.value as { marked: boolean };
        await guarded(response, SET.contract.id, async () => {
          const written = await port.set(token, assignmentId, marked);
          if (written.kind === "ok") return sendMark(response, SET, written.marked);
          const [status, code] = WRITE_REFUSALS[written.kind] ?? [503, "unavailable"];
          sendProblem(response, status, code);
        });
      },
    },
    {
      contract: HOLDER.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = idOf(params?.assignmentId);
        const studentId = idOf(params?.studentId);
        if (assignmentId === null || studentId === null) {
          return sendProblem(response, 404, "not_found");
        }
        await guarded(response, HOLDER.contract.id, async () =>
          sendRead(response, HOLDER, await port.read(token, assignmentId, studentId)),
        );
      },
    },
  ];
}

/** The three routes over main's application withActor. */
export function createWorkAccommodationRoutesFor(main: { withActor: WithActor }): Route[] {
  const { withActor } = main;
  return createWorkAccommodationRoutes({
    readOwn: (token, assignmentId) => readOwnWorkAccommodation(token, withActor, assignmentId),
    read: (token, assignmentId, studentId) =>
      readWorkAccommodation(token, withActor, assignmentId, studentId),
    set: (token, assignmentId, marked) =>
      setWorkAccommodation(token, withActor, assignmentId, marked),
  });
}
