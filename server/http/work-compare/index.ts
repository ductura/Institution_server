// GET /api/v1/works/{documentId}/compare?from=&to= (work.compare.get, SRV-2004).
// The edge only: a live session cookie (401), a path id decoded once (an id that
// is not one is the same 404 as another's work, C-23), exactly the query
// {from, to} as revision numbers with from < to (422), then the comparison of
// server/evidence/compare over the replay source bound to the session. The
// database decides who may read; the owner and a teacher of the work get the
// same answer, and a teacher's read writes the access log row inside the
// replay source. A throw or an unreadable record is 503 and reported.
import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createReplaySource, type WithActor } from "../../database/index.ts";
import { compareWorkVersions } from "../../evidence/index.ts";
import {
  createEditStepsV1Replayer,
  createEditStepsV3Replayer,
  type InstitutionEvidencePayloadReader,
} from "../../external/storage/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { reportServerError, requestIdOf, type Route, sendJson, sendProblem } from "../index.ts";

const CONTRACT = ROUTES.find((route) => route.id === "work.compare.get")!;

type Compare = (
  token: string,
  documentId: string,
  from: number,
  to: number,
) => ReturnType<typeof compareWorkVersions>;

function revisionOf(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,15}(?![\s\S])/u.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function createWorkCompareRoute(compare: Compare): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      const target = request.url ?? "";
      const queryStart = target.indexOf("?");
      const query = new URLSearchParams(queryStart === -1 ? "" : target.slice(queryStart + 1));
      const from = revisionOf(query.get("from"));
      const to = revisionOf(query.get("to"));
      if (query.size !== 2 || from === null || to === null || from >= to) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await compare(token, documentId, from, to);
        if (result.status === "ok") {
          return sendJson(response, 200, {
            from: result.from,
            to: result.to,
            blocks: result.blocks,
          });
        }
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
        if (result.status === "unavailable") {
          reportServerError(
            "route",
            new Error(`compare unavailable: ${result.reason}`),
            requestIdOf(response),
            CONTRACT.id,
          );
        }
        // too_large and unavailable: whole failures, never a partial answer.
        return sendProblem(response, 503, "unavailable");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's session (withActor) and the storage of every institution. */
export function createWorkCompareRouteFor(
  main: { readonly withActor: WithActor },
  deps: { readonly payloads: InstitutionEvidencePayloadReader },
): Route {
  return createWorkCompareRoute((token, documentId, from, to) =>
    compareWorkVersions(
      {
        source: createReplaySource(main.withActor, token),
        payloads: deps.payloads,
        replayers: { v1: createEditStepsV1Replayer(), v3: createEditStepsV3Replayer() },
      },
      documentId,
      from,
      to,
    ),
  );
}
