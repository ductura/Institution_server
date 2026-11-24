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
// GET /api/v1/works/{documentId}/origin-segments (SRV-KARTA-RASPON): the ranges
// of origin of a revision, from app.work_origin_segments, with the same access
// and the same 404 as the composition. Only ?revision is accepted, a whole
// number up to 2^53-1; anything else in the query is 422.
const SEGMENTS = ROUTES.find((route) => route.id === "work.origin-segments.get")!;
const SEGMENTS_BODY = SEGMENTS.responses.find((response) => response.status === 200)!.body!;

/** The revision asked for: null when absent, undefined when the query is not exactly ?revision=n. */
function revisionOf(url: string | undefined): number | null | undefined {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  const keys = [...query.keys()];
  if (keys.length === 0) return null;
  if (keys.length !== 1 || keys[0] !== "revision") return undefined;
  const text = query.get("revision")!;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(text)) return undefined;
  const revision = Number(text);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function unavailable(
  response: Parameters<typeof sendProblem>[0],
  error: unknown,
  routeId: string = GET.id,
) {
  reportServerError("route", error, requestIdOf(response), routeId);
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
    {
      contract: SEGMENTS,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const revision = revisionOf(request.url);
        if (revision === undefined) return sendProblem(response, 422, "invalid_input");
        const result = await origin.segments(token, documentId, revision);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated")
            return sendProblem(response, 401, "unauthorized");
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
          return unavailable(response, new Error("origin segments unavailable"), SEGMENTS.id);
        }
        const body = { revision: result.revision, segments: result.segments };
        if (!Value.Check(SEGMENTS_BODY, body)) {
          return unavailable(response, new Error("invalid origin segments"), SEGMENTS.id);
        }
        sendJson(response, 200, body);
      },
    },
  ];
}
