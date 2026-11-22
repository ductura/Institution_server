import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createOriginKind, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

// GET /api/v1/works/{documentId}/origin-composition (SRV-0910): the share of a
// work per kind of origin. The session decides who asks;
// app.work_origin_composition decides whether the caller owns or may read the
// work. Another's, an unknown and a malformed work read the same 404 (C-23).
// The student and the teacher get the same bytes.
const GET = ROUTES.find((route) => route.id === "work.origin-composition.get")!;
const GET_BODY = GET.responses.find((response) => response.status === 200)!.body!;

function unavailable(response: Parameters<typeof sendProblem>[0], error: unknown) {
  reportServerError("route", error, requestIdOf(response), GET.id);
  sendProblem(response, 503, "unavailable");
}

export function createOriginCompositionRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const origin = createOriginKind(withActor);
  return [
    {
      contract: GET,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await origin.composition(token, documentId);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated")
            return sendProblem(response, 401, "unauthorized");
          if (result.status === "not_found" || result.status === "invalid") {
            return sendProblem(response, 404, "not_found");
          }
          return unavailable(response, new Error("origin composition unavailable"));
        }
        const body = { parts: result.parts };
        if (!Value.Check(GET_BODY, body)) {
          return unavailable(response, new Error("invalid origin composition"));
        }
        sendJson(response, 200, body);
      },
    },
  ];
}
