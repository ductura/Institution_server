import { workAccessGet, workIdFromPath } from "../../contracts/index.ts";
import {
  createWorkAccessReader,
  type WithActor,
  type WorkAccessReader,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

/**
 * GET /api/v1/works/{documentId}/access (work.access.get, SRV-1706, plan
 * M10.4): who opened the caller's own work and when, in Zagreb days of
 * five-minute rows, with no total and no duration (D-274 MQ10). The edge as
 * student.access-log.get: Sec-Fetch-Site, when sent, exactly one same-origin
 * (403), then a live session cookie (401); a work id that is not one is the
 * same 404 as another's work (C-23). The cursor is exactly one beforeAt and
 * one beforeId; anything else reads the first page. A throw is 503 and reported.
 */
export function createWorkAccessRoute(
  reader: WorkAccessReader,
  now: () => number = Date.now,
): Route {
  return {
    contract: workAccessGet,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return sendProblem(response, 404, "not_found");
      const target = request.url ?? "";
      const query = new URLSearchParams(
        target.includes("?") ? target.slice(target.indexOf("?") + 1) : "",
      );
      const at = query.getAll("beforeAt");
      const id = query.getAll("beforeId");
      const cursor =
        at.length === 1 && id.length === 1 ? { beforeAt: at[0]!, beforeId: id[0]! } : null;
      try {
        const read = await reader.read(token, documentId, cursor, now());
        if (read.ok) return sendJson(response, 200, read.value);
        if (read.error.code === "MY_ACCESS_LOG_UNAUTHENTICATED") {
          return sendProblem(response, 401, "unauthorized");
        }
        if (read.error.code === "MY_ACCESS_LOG_NOT_FOUND") {
          return sendProblem(response, 404, "not_found");
        }
        return sendProblem(response, 503, "unavailable");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), workAccessGet.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createWorkAccessRouteFor(main: { withActor: WithActor }): Route {
  return createWorkAccessRoute(createWorkAccessReader(main.withActor));
}
