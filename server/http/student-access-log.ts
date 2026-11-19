// GET /api/v1/student/works/{documentId}/access-log (student.access-log.get,
// SRV-11, Ductus#2028 c.7008147932): who opened the caller's own work and
// when. The HTTP edge only, as profile-me.ts: Sec-Fetch-Site, when sent,
// exactly one same-origin (403), then a live session cookie (401); the work id
// is decoded once by workIdFromPath, and one that is not a work id is the same
// 404 as another's work (C-23). The page and the cursor are
// server/institution/student-access-log-route.ts; a throw is 503 and reported.
import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import { createMyAccessLogReader, type MyAccessLogReader } from "../database/index.ts";
import { readStudentAccessLog } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "student.access-log.get");
  if (found === undefined) throw new Error("no contract student.access-log.get");
  return found;
})();

const PROBLEM = { 401: "unauthorized", 404: "not_found", 503: "unavailable" } as const;

export function createStudentAccessLogRoute(
  reader: MyAccessLogReader,
  now: () => number = Date.now,
): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return sendProblem(response, 404, "not_found");
      const query = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
      try {
        const answer = await readStudentAccessLog(reader, token, documentId, query, now());
        if (answer.status === 200) return sendJson(response, 200, answer.body);
        return sendProblem(response, answer.status, PROBLEM[answer.status]);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createStudentAccessLogRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createStudentAccessLogRoute(createMyAccessLogReader(main.withActor));
}
