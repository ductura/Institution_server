// GET /api/v1/works/{documentId}/versions (work.versions.get, SRV-9A,
// Ductus#2028): one page of the versions of a work, the same for its owner
// and the teacher of its assignment. The HTTP edge only, as
// student-access-log.ts: a live session cookie (401), the work id decoded once
// by workIdFromPath (one that is not a work id is the same 404 as another's
// work, C-23), then server/evidence/versions for the closed query, the page
// and its outcomes. A throw is 503 and reported; a page the port could not
// vouch for is 503 with one line naming its closed reason, never content.
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../contracts/index.ts";
import { createWorkVersionsReader, type WorkVersionsReader } from "../database/index.ts";
import { answerWorkVersions } from "../evidence/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "work.versions.get");
  if (found === undefined) throw new Error("no contract work.versions.get");
  return found;
})();

/** One line on stderr: a closed reason code and the request id, never an id or work content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "work_versions_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

export function createWorkVersionsRoute(read: WorkVersionsReader): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      const query = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
      try {
        const answer = await answerWorkVersions(read, token, documentId, query);
        if (answer.status === 200) return sendJson(response, 200, answer.body);
        if (answer.status === 503) unavailable(response, answer.reason);
        return sendProblem(response, answer.status, answer.code);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createWorkVersionsRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createWorkVersionsRoute(createWorkVersionsReader(main.withActor));
}
