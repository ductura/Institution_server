import { Value } from "@sinclair/typebox/value";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createRevisionRestore,
  type RevisionRestore,
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

// The record of a restore over HTTP (INT-21 C):
//   POST /api/v1/works/{documentId}/restores  {fromRevision}
// The session decides who asks; app.record_revision_restore decides whether
// the caller owns the work and which later revision the restore lands on.
// Another's, an unknown and a malformed work read the same 404 (C-23). The
// body names only the revision restored from, and the answer is checked
// against its contract before it leaves.
const found = ROUTES.find((route) => route.id === "work.restore.post");
const ANSWER = found?.responses.find((response) => response.status === 200)?.body;
if (found === undefined || ANSWER === undefined) throw new Error("no contract work.restore.post");
const ROUTE = found;
const SCHEMA = ANSWER;

const BODY_TIMEOUT_MS = 5_000;

/** The JSON body exactly as the contract says, or a refusal already sent. */
async function bodyOf(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<{ ok: true; value: { fromRevision: number } } | { ok: false }> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(request, ROUTE.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  if (!Value.Check(ROUTE.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return { ok: false };
  }
  return { ok: true, value: json.value as { fromRevision: number } };
}

export function createRevisionRestoreRoute(record: RevisionRestore): Route {
  return {
    contract: ROUTE,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const parsed = await bodyOf(request, response);
      if (!parsed.ok) return;
      const id = workIdFromPath(params?.documentId ?? "");
      if (id === null || !isWorkId(id)) return sendProblem(response, 404, "not_found");
      const result = await record(token, id, parsed.value.fromRevision);
      if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (result.status === "not_found") return sendProblem(response, 404, "not_found");
      if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
      // Only the outcome and the revision it names leave, and that revision is
      // always later than the one restored from.
      const body =
        result.status !== "ok"
          ? undefined
          : "revision" in result
            ? { outcome: result.outcome, revision: result.revision }
            : { outcome: result.outcome };
      const later =
        body === undefined || !("revision" in body) || body.revision > parsed.value.fromRevision;
      if (body === undefined || !later || !Value.Check(SCHEMA, body)) {
        const reason = body === undefined ? result.status : "answer outside the contract";
        reportServerError("route", new Error(reason), requestIdOf(response), ROUTE.id);
        return sendProblem(response, 503, "unavailable");
      }
      sendJson(response, 200, body);
    },
  };
}

export function createRevisionRestoreRouteFor({ withActor }: { withActor: WithActor }): Route {
  return createRevisionRestoreRoute(createRevisionRestore(withActor));
}
