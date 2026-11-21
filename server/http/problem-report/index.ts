import { Value } from "@sinclair/typebox/value";

import { ProblemReportInput, problemReportsPost } from "../../contracts/index.ts";
import {
  createProblemReportStore,
  PROBLEM_REPORT_INVALID,
  PROBLEM_REPORT_TOO_MANY,
  PROBLEM_REPORT_UNAUTHENTICATED,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

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

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

export function createProblemReportsRouteFor({ withActor }: { withActor: WithActor }): Route {
  const store = createProblemReportStore(withActor);
  return {
    contract: problemReportsPost,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        problemReportsPost.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(ProblemReportInput, json.value))
        return sendProblem(response, 422, "invalid_input");

      const submitted = await store.submit(token, {
        ...json.value,
        route: null,
        browserFamily: "other",
        browserMajor: null,
        syncState: null,
      });
      if (!submitted.ok) {
        const { code } = submitted.error;
        if (code === PROBLEM_REPORT_UNAUTHENTICATED.code)
          return sendProblem(response, 401, "unauthorized");
        if (code === PROBLEM_REPORT_INVALID.code)
          return sendProblem(response, 422, "invalid_input");
        if (code === PROBLEM_REPORT_TOO_MANY.code)
          return sendProblem(response, 429, "too_many_reports");
        reportServerError("route", submitted.error, requestIdOf(response), problemReportsPost.id);
        return sendProblem(response, 503, "unavailable");
      }
      sendJson(response, 201, { reference: submitted.value });
      void recordActivity(token, withActor).catch(() => undefined);
    },
  };
}
