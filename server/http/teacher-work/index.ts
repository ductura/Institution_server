import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createTeacherWork, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

// GET /api/v1/teacher/works/{documentId} (SRV-2003): the teacher's read of one
// work by its document id. The session decides who asks; app.teacher_work_get
// decides whether the caller may read the work. Another teacher's, the
// student's own, an unknown work and a malformed id all read the same 404.
const GET = ROUTES.find((route) => route.id === "teacher.work.get")!;
const GET_BODY = GET.responses.find((response) => response.status === 200)!.body!;

function unavailable(response: Parameters<typeof sendProblem>[0], error: unknown) {
  reportServerError("route", error, requestIdOf(response), GET.id);
  sendProblem(response, 503, "unavailable");
}

export function createTeacherWorkRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const works = createTeacherWork(withActor);
  return [
    {
      contract: GET,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await works.get(token, documentId);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          return unavailable(response, new Error("teacher work unavailable"));
        }
        if (!Value.Check(GET_BODY, result.work)) {
          return unavailable(response, new Error("invalid teacher work"));
        }
        sendJson(response, 200, result.work);
      },
    },
  ];
}
