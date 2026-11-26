// GET /api/v1/works/{documentId}/revision-due (work.revision-due.get), F4-NAS-R16-SRV:
// the revision due date of the open return of a work. The HTTP edge only; the rules
// are the database's (server/database/work-revision-due, migration 20261220340000).
// A malformed id and anybody with no part in the work are the same 404 (C-23); an
// answer outside the contract, or a throw, is 503.
import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkRevisionDue, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

const CONTRACT = ROUTES.find((route) => route.id === "work.revision-due.get")!;
const BODY = CONTRACT.responses.find((response) => response.status === 200)!.body!;

export function createWorkRevisionDueRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const port = createWorkRevisionDue(withActor);
  return [
    {
      contract: CONTRACT,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await port.read(token, documentId);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        if (result.status !== "ok") {
          reportServerError(
            "route",
            new Error("revision due unavailable"),
            requestIdOf(response),
            CONTRACT.id,
          );
          return sendProblem(response, 503, "unavailable");
        }
        const body = { returned: result.returned };
        if (!Value.Check(BODY, body)) {
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            CONTRACT.id,
          );
          return sendProblem(response, 503, "unavailable");
        }
        sendJson(response, 200, body);
      },
    },
  ];
}
