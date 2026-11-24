// GET /api/v1/problem-reports and POST /api/v1/problem-reports/{reference}/status
// (SRV-ADMIN-1, NF-7 OA-7; contracts support.problem-reports.get and
// support.problem-report-status.post) over the routed reports of migration
// 20261215100000. The HTTP edge only: which reports reach whom, and who may
// change a state, is the database's. The read refuses a cross-site request
// and any query; the change goes through the shared origin layer and the
// JSON body reader. An answer outside the contract, or a throw, is 503 and the
// throw is reported, never a partial answer.
import { Value } from "@sinclair/typebox/value";

import {
  PROBLEM_REPORTS_PAGE,
  problemReportStatusPost,
  problemReportsGet,
} from "../../contracts/index.ts";
import {
  createProblemReportInbox,
  type ProblemReportInbox,
  type ProblemReportStatus,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["invalid", [422, "invalid_input"]],
] as const);

const refusalOf = (status: string): readonly [number, string] =>
  REFUSALS.get(status) ?? [503, "unavailable"];

const LIST_BODY = problemReportsGet.responses[0]!.body!;
const STATUS_BODY = problemReportStatusPost.responses[0]!.body!;
const STATUS_INPUT = problemReportStatusPost.request.body!;

export type ProblemReportInboxRouteOptions = {
  readonly inbox: ProblemReportInbox;
  /** Session activity for an accepted change (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

function listRoute({ inbox }: ProblemReportInboxRouteOptions): Route {
  return {
    contract: problemReportsGet,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await inbox.list(token, PROBLEM_REPORTS_PAGE);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { reports: result.reports, truncated: result.truncated };
        if (Value.Check(LIST_BODY, answer)) return sendJson(response, 200, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          problemReportsGet.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), problemReportsGet.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

function statusRoute(options: ProblemReportInboxRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  return {
    contract: problemReportStatusPost,
    async handle(request, response, params) {
      const read = await readInstitutionJson(
        request,
        response,
        [],
        problemReportStatusPost.request.maxBodyBytes!,
        timeoutMs,
      );
      if (read === null) return;
      const reference = params?.reference ?? "";
      if (!Value.Check(STATUS_INPUT, read.value))
        return sendProblem(response, 422, "invalid_input");
      const { status: wanted } = read.value as { status: ProblemReportStatus };
      try {
        const result = await options.inbox.setStatus(read.token, reference, wanted);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = {
          reference,
          status: result.reportStatus,
          statusChangedAt: result.changedAt,
        };
        if (Value.Check(STATUS_BODY, answer)) {
          sendJson(response, 200, answer);
          void options.recordActivity(read.token).catch(() => undefined);
          return;
        }
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          problemReportStatusPost.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), problemReportStatusPost.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The read and the change of state over one port. */
export function createProblemReportInboxRoutes(options: ProblemReportInboxRouteOptions): Route[] {
  return [listRoute(options), statusRoute(options)];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createProblemReportInboxRoutesFor(main: { withActor: WithActor }): Route[] {
  return createProblemReportInboxRoutes({
    inbox: createProblemReportInbox(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
