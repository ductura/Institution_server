// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission
// (teacher.submission-receipt.get), SRV-30 (Ductus#2028 c.7009405737): one
// student's submission state and signed receipt for a reader of that student's
// work. The HTTP edge only, as student-submission.ts: Sec-Fetch-Site, when
// sent, exactly one same-origin (403), then a live session cookie (401); an id
// that is not a uuid is the same 404 as a refused or unknown one (C-23), and
// an upper-case uuid is read as its lower-case form. The answer is
// server/institution/teacher-submission-route.ts; a body the contract does not
// accept, or a throw, is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { MySubmissionStateReader } from "../database/index.ts";
import { readTeacherSubmission } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const ID = "teacher.submission-receipt.get";
const PROBLEM = { 401: "unauthorized", 404: "not_found", 503: "unavailable" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTeacherSubmissionReceiptRoute(reader: MySubmissionStateReader): Route {
  const contract = ROUTES.find((route) => route.id === ID);
  const body = contract?.responses.find((response) => response.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${ID}`);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = params?.assignmentId ?? "";
      const studentId = params?.studentId ?? "";
      if (!UUID.test(assignmentId) || !UUID.test(studentId)) {
        return sendProblem(response, 404, "not_found");
      }
      try {
        const answer = await readTeacherSubmission(
          reader,
          token,
          assignmentId.toLowerCase(),
          studentId.toLowerCase(),
        );
        if (answer.status !== 200)
          return sendProblem(response, answer.status, PROBLEM[answer.status]);
        if (Value.Check(body, answer.body)) return sendJson(response, 200, answer.body);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          ID,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), ID);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}
