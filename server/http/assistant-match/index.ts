import { Value } from "@sinclair/typebox/value";
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createAssistantMatch, type WithActor } from "../../database/index.ts";
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

// GET and POST /api/v1/works/{documentId}/assistant-match (SRV-1230, P-1 rule 13):
// the match of a segment with an answer of the assistant of the same work. The
// session decides who asks; app.assistant_match_* decide whether the caller owns
// or may read the work. Another's, an unknown and a malformed work, and a
// caller who is not the owner on POST, read the same 404 (C-23). The student and
// the teacher get the same findings.
const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const LIST = contract("work.assistant-match.get");
const CHECK = contract("work.assistant-match.post");
const LIST_BODY = LIST.responses.find((response) => response.status === 200)!.body!;
const CHECK_BODY = CHECK.responses.find((response) => response.status === 200)!.body!;

const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;

/** NFC, no control character but newline and tab, no bidirectional control: the server's part of the text rule. */
function isCleanText(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !/\p{Cc}/u.test(value.replace(/[\n\t\r]/gu, "")) &&
    !BIDI.test(value)
  );
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

function workOf(segment: string | undefined): string | null {
  const id = workIdFromPath(segment ?? "");
  return id !== null && isWorkId(id) ? id : null;
}

export function createAssistantMatchRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const match = createAssistantMatch(withActor);
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await match.list(token, documentId);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found" || result.status === "invalid") {
          return sendProblem(response, 404, "not_found");
        }
        if (result.status !== "ok") return unavailable(response, LIST.id, new Error(result.status));
        const body = { findings: result.findings };
        if (!Value.Check(LIST_BODY, body)) {
          return unavailable(response, LIST.id, new Error("invalid assistant match findings"));
        }
        sendJson(response, 200, body);
      },
    },
    {
      contract: CHECK,
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
        const raw = await readBodyWithLimit(request, CHECK.request.maxBodyBytes!, BODY_TIMEOUT_MS);
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(CHECK.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { segmentRef, text } = json.value as { segmentRef: string; text: string };
        if (!isCleanText(segmentRef) || !isCleanText(text)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await match.check(token, documentId, segmentRef, text);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "ok")
          return unavailable(response, CHECK.id, new Error(result.status));
        const body = { matches: result.matches };
        if (!Value.Check(CHECK_BODY, body)) {
          return unavailable(response, CHECK.id, new Error("invalid assistant match answer"));
        }
        sendJson(response, 200, body);
      },
    },
  ];
}
