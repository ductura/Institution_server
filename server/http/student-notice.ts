// GET /api/v1/student/assignments/{assignmentId}/notice (student.notice.get),
// SRV-NG (Ductus#2028 c.7019543739): the notice of the current version of an
// assignment for a student of its course (E-6). The HTTP edge only, as
// student-submission.ts: Sec-Fetch-Site, when sent, exactly one same-origin
// (403), then a live session cookie (401); an id that is not a uuid is the
// same 404 as another's or an unknown one (C-23), and an upper-case uuid is
// read as its lower-case form. The fields come from
// server/database/student-notice.ts, with the notice template version; a body
// the contract does not accept, or a throw, is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createStudentNoticeReader, type StudentNoticeReader } from "../database/index.ts";
import { NOTICE_TEMPLATE_VERSION } from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const ID = "student.notice.get";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The codes of STUDENT_NOTICE_* (server/database/student-notice.ts).
const UNAUTHENTICATED = "STUDENT_NOTICE_UNAUTHENTICATED";
const NOT_FOUND = "STUDENT_NOTICE_NOT_FOUND";

export function createStudentNoticeRoute(reader: StudentNoticeReader): Route {
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
      const sent = params?.assignmentId ?? "";
      if (!UUID.test(sent)) return sendProblem(response, 404, "not_found");
      try {
        const read = await reader.read(token, sent.toLowerCase());
        if (!read.ok) {
          if (read.error.code === UNAUTHENTICATED)
            return sendProblem(response, 401, "unauthorized");
          if (read.error.code === NOT_FOUND) return sendProblem(response, 404, "not_found");
          return sendProblem(response, 503, "unavailable");
        }
        const answer = { ...read.value, templateVersion: NOTICE_TEMPLATE_VERSION };
        if (Value.Check(body, answer)) return sendJson(response, 200, answer);
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

/** The route over main's application withActor. */
export function createStudentNoticeRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createStudentNoticeRoute(createStudentNoticeReader(main.withActor));
}
