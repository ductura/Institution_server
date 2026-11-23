import { Value } from "@sinclair/typebox/value";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isWorkId, RHYTHM_MAX_GAP_MS, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createInputRhythm, type InputRhythm, type WithActor } from "../../database/index.ts";
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

// The rhythm of typing over HTTP (PIL-P1-RITAM-SRV, P-1 rule 4):
//   POST, GET, DELETE /api/v1/works/{documentId}/input-rhythm
//   GET /api/v1/works/{documentId}/input-rhythm/setting
//   GET, PUT, DELETE /api/v1/teacher/assignments/{assignmentId}/input-rhythm
//   GET, PUT /api/v1/teacher/courses/{courseId}/input-rhythm (PIL-P1-RITAM-PREDMET-SRV)
// The session decides who asks; app.input_rhythm_* decide whether the caller
// owns or reads the work, or teaches the assignment. Another's, an unknown and
// a malformed work or assignment, and a caller without the relation, read the
// same 404 (C-23). A body carries the gaps or the switch and nothing else, and
// every answer is checked against its contract before it leaves: no key and no
// measure derived from the gaps can pass.
const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  const body = found?.responses.find((response) => response.status === 200)?.body;
  if (found === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { route: found, body };
};
const RECORD = contract("work.input-rhythm.post");
const READ = contract("work.input-rhythm.get");
const REMOVE = contract("work.input-rhythm.delete");
const STATE = contract("work.input-rhythm-setting.get");
const SWITCH_READ = contract("teacher.input-rhythm.get");
const SWITCH = contract("teacher.input-rhythm.put");
const CLEAR = contract("teacher.input-rhythm.delete");
const COURSE_READ = contract("teacher.course-input-rhythm.get");
const COURSE_SWITCH = contract("teacher.course-input-rhythm.put");

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Failure = { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };
type Contract = ReturnType<typeof contract>;

function workOf(segment: string | undefined): string | null {
  const id = workIdFromPath(segment ?? "");
  return id !== null && isWorkId(id) ? id : null;
}

/** A UUID path segment (assignment or course), or null. */
function assignmentOf(segment: string | undefined): string | null {
  return segment !== undefined && UUID.test(segment) ? segment : null;
}

/** The answer of the port: 401, 404 (also for invalid on a read), 422 or 503, else the checked body. */
function answer(
  response: ServerResponse,
  { route, body: schema }: Contract,
  result: Failure | ({ readonly status: "ok" } & Record<string, unknown>),
  body: (ok: Record<string, unknown>) => unknown,
  invalid: 404 | 422,
): void {
  if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (result.status === "not_found") return sendProblem(response, 404, "not_found");
  if (result.status === "invalid") {
    return invalid === 422
      ? sendProblem(response, 422, "invalid_input")
      : sendProblem(response, 404, "not_found");
  }
  if (result.status !== "ok") {
    reportServerError("route", new Error(result.status), requestIdOf(response), route.id);
    return sendProblem(response, 503, "unavailable");
  }
  const value = body(result);
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

/** The JSON body of a mutation, exactly as the contract says, or a refusal already sent. */
async function bodyOf(
  request: IncomingMessage,
  response: ServerResponse,
  { route }: Contract,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(request, route.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  if (!Value.Check(route.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return { ok: false };
  }
  return { ok: true, value: json.value };
}

const switchOf = (ok: Record<string, unknown>) => ({
  enabled: ok.enabled,
  source: ok.source,
  changedBy: ok.changedBy,
  changedAt: ok.changedAt,
});

export function createInputRhythmRoutes(rhythm: InputRhythm): Route[] {
  return [
    {
      contract: RECORD.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const parsed = await bodyOf(request, response, RECORD);
        if (!parsed.ok) return;
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const { gapsMs } = parsed.value as { gapsMs: number[] };
        if (!gapsMs.every((gap) => gap >= 0 && gap <= RHYTHM_MAX_GAP_MS)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const result = await rhythm.record(token, documentId, gapsMs);
        answer(response, RECORD, result, (ok) => ({ recorded: ok.recorded }), 422);
      },
    },
    {
      contract: READ.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.read(token, documentId);
        answer(response, READ, result, (ok) => ({ bursts: ok.bursts }), 404);
      },
    },
    {
      contract: REMOVE.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.remove(token, documentId);
        answer(response, REMOVE, result, (ok) => ({ deleted: ok.deleted }), 404);
      },
    },
    {
      contract: STATE.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.state(token, documentId);
        answer(response, STATE, result, switchOf, 404);
      },
    },
    {
      contract: SWITCH_READ.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = assignmentOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.readEnabled(token, assignmentId);
        answer(response, SWITCH_READ, result, switchOf, 404);
      },
    },
    {
      contract: SWITCH.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const parsed = await bodyOf(request, response, SWITCH);
        if (!parsed.ok) return;
        const assignmentId = assignmentOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        const { enabled } = parsed.value as { enabled: boolean };
        const result = await rhythm.setEnabled(token, assignmentId, enabled);
        answer(response, SWITCH, result, switchOf, 422);
      },
    },
    {
      contract: CLEAR.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const assignmentId = assignmentOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.clearEnabled(token, assignmentId);
        answer(response, CLEAR, result, switchOf, 404);
      },
    },
    {
      contract: COURSE_READ.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const courseId = assignmentOf(params?.courseId);
        if (courseId === null) return sendProblem(response, 404, "not_found");
        const result = await rhythm.readCourseEnabled(token, courseId);
        answer(response, COURSE_READ, result, switchOf, 404);
      },
    },
    {
      contract: COURSE_SWITCH.route,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const parsed = await bodyOf(request, response, COURSE_SWITCH);
        if (!parsed.ok) return;
        const courseId = assignmentOf(params?.courseId);
        if (courseId === null) return sendProblem(response, 404, "not_found");
        const { enabled } = parsed.value as { enabled: boolean };
        const result = await rhythm.setCourseEnabled(token, courseId, enabled);
        answer(response, COURSE_SWITCH, result, switchOf, 422);
      },
    },
  ];
}

export function createInputRhythmRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  return createInputRhythmRoutes(createInputRhythm(withActor));
}
