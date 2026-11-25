// GET /api/v1/student/assignments/{assignmentId}/assistant-conversations
// (student.assistant-conversations.get), SRV-ASIST-CITANJE (Ductus#2055
// c.7142266537): the caller's own assistant conversations of an assignment,
// without message text. The HTTP edge only, as student-notice.ts:
// Sec-Fetch-Site, when sent, exactly one same-origin (403), then a live
// session cookie (401); an id that is not a uuid is the same 404 as another's
// or an unknown one (C-23), and an upper-case uuid is read as its lower-case
// form. The rows come from server/database/student-assistant-conversations.ts;
// a body the contract does not accept, or a throw, is 503 and is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createStudentConversationsReader,
  type StudentConversationsReader,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const ID = "student.assistant-conversations.get";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The codes of STUDENT_CONVERSATIONS_* (server/database/student-assistant-conversations.ts).
const UNAUTHENTICATED = "STUDENT_CONVERSATIONS_UNAUTHENTICATED";
const NOT_FOUND = "STUDENT_CONVERSATIONS_NOT_FOUND";

export function createStudentConversationsRoute(reader: StudentConversationsReader): Route {
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
        const assignmentId = sent.toLowerCase();
        const read = await reader.read(token, assignmentId);
        if (!read.ok) {
          if (read.error.code === UNAUTHENTICATED)
            return sendProblem(response, 401, "unauthorized");
          if (read.error.code === NOT_FOUND) return sendProblem(response, 404, "not_found");
          return sendProblem(response, 503, "unavailable");
        }
        const answer = { assignmentId, conversations: read.value };
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
export function createStudentConversationsRouteFor(
  main: Pick<Databases["main"], "withActor">,
): Route {
  return createStudentConversationsRoute(createStudentConversationsReader(main.withActor));
}
