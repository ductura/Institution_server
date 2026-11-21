// GET and PUT /api/v1/works/{documentId}/direct-edit (work.direct-edit.get and
// work.direct-edit.put, SRV-1702; M6.4, D-21, D-34, D-244): the direct-edit
// setting of a work and its record. The HTTP edge only, as work-messages: a
// live session cookie (401), the work id decoded once by workIdFromPath (one
// that is not a work id is the same 404 as another's work, C-23), for the PUT
// the media type, the bounded body and its shape, then
// server/database/direct-edit. The database decides who may: only the student
// owner sets the mode, the student and the teachers of the work read the same
// answer; a refusal of the relation is 404, another mode 422. A throw is 503
// and reported. The teacher's edit itself goes through live.document.put.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createDirectEdits,
  type DirectEditMode,
  type DirectEdits,
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

const find = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const GET_CONTRACT = find("work.direct-edit.get");
const PUT_CONTRACT = find("work.direct-edit.put");
const BODY = PUT_CONTRACT.request.body!;
const BODY_TIMEOUT_MS = 5_000;

/** Answers a closed refusal of the port with its status and problem code. */
function refusalOf(
  response: ServerResponse,
  status: "unauthenticated" | "not_found" | "invalid" | "unavailable",
): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  return sendProblem(response, 503, "unavailable");
}

export function createDirectEditGetRoute(edits: DirectEdits): Route {
  return {
    contract: GET_CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      try {
        const answer = await edits.read(token, documentId);
        if (answer.status !== "ok") return refusalOf(response, answer.status);
        return sendJson(response, 200, {
          mode: answer.mode,
          changedAt: answer.changedAt,
          record: answer.record,
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GET_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createDirectEditPutRoute(edits: DirectEdits): Route {
  return {
    contract: PUT_CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return refuse(response, 404, "not_found");
      }
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        PUT_CONTRACT.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(BODY, json.value)) return sendProblem(response, 422, "invalid_input");
      const { mode } = json.value as { mode: DirectEditMode };
      try {
        const answer = await edits.set(token, documentId, mode);
        if (answer.status !== "ok") return refusalOf(response, answer.status);
        return sendJson(response, 200, {
          outcome: answer.outcome,
          mode: answer.mode,
          changedAt: answer.changedAt,
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), PUT_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** Both routes over main's application withActor. */
export function createDirectEditRoutesFor(main: { withActor: WithActor }): Route[] {
  const edits = createDirectEdits(main.withActor);
  return [createDirectEditGetRoute(edits), createDirectEditPutRoute(edits)];
}
