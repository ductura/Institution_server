// GET and POST /api/v1/works/{documentId}/messages (work.messages.get and
// work.messages.post, SRV-1106): the short messages next to a work, one
// conversation for its student and the teachers of its assignment. The HTTP
// edge only, as work-versions.ts: a live session cookie (401), the work id
// decoded once by workIdFromPath (one that is not a work id is the same 404 as
// another's work, C-23), for the POST the media type, the bounded body and its
// shape, then server/database/work-messages. The database decides who may; a
// refusal of the relation is 404, an empty or blank message 422 and writes
// nothing. A throw is 503 and reported.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkMessages, type WorkMessages } from "../../database/index.ts";
import type { WithActor } from "../../database/index.ts";
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
const GET_CONTRACT = find("work.messages.get");
const POST_CONTRACT = find("work.messages.post");
const BODY = POST_CONTRACT.request.body!;
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;

/** The status and problem code of a closed refusal of the port. */
const REFUSALS = {
  unauthenticated: [401, "unauthorized"],
  not_found: [404, "not_found"],
  invalid: [422, "invalid_input"],
  unavailable: [503, "unavailable"],
} as const;

function refusalOf(response: ServerResponse, status: keyof typeof REFUSALS): void {
  const [code, problem] = REFUSALS[status];
  return sendProblem(response, code, problem);
}

export function createWorkMessagesGetRoute(messages: WorkMessages): Route {
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
        const answer = await messages.list(token, documentId);
        if (answer.status === "ok") return sendJson(response, 200, { messages: answer.messages });
        return refusalOf(response, answer.status);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GET_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createWorkMessagesPostRoute(messages: WorkMessages): Route {
  return {
    contract: POST_CONTRACT,
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
        POST_CONTRACT.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(BODY, json.value)) return sendProblem(response, 422, "invalid_input");
      const { text } = json.value as { text: string };
      if (
        text !== text.normalize("NFC") ||
        /\p{Cc}/u.test(text.replace(/[\n\t]/gu, "")) ||
        BIDI.test(text)
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const answer = await messages.create(token, documentId, text);
        if (answer.status === "created") return sendJson(response, 201, answer.message);
        return refusalOf(response, answer.status);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), POST_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** Both routes over main's application withActor. */
export function createWorkMessagesRoutesFor(main: { withActor: WithActor }): Route[] {
  const messages = createWorkMessages(main.withActor);
  return [createWorkMessagesGetRoute(messages), createWorkMessagesPostRoute(messages)];
}
