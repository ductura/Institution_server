import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { readTextCheckConfig, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

// GET /api/v1/student/assignments/{assignmentId}/text-check-config
// (student.text-check-config.get, SRV-1101, C-12). One withActor transaction:
// the assignment must be in the caller's workspace (app.student_workspace, the
// same access as the work itself), then the institution settings the caller may
// read (settings.read_institution_values, SRV-7E: the editor reads only
// lekta.profile and citation.style). Nothing of any work is read or returned.
const CONTRACT = ROUTES.find((route) => route.id === "student.text-check-config.get")!;
const BODY = CONTRACT.responses.find((response) => response.status === 200)!.body!;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function createTextCheckConfigRoute({ withActor }: { withActor: WithActor }): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const id = workIdFromPath(params?.assignmentId ?? "");
      if (id === null || !UUID.test(id)) return sendProblem(response, 404, "not_found");
      try {
        const config = await readTextCheckConfig(withActor, token, id);
        if (config === null) return sendProblem(response, 404, "not_found");
        if (!Value.Check(BODY, config)) throw new Error("invalid text check config");
        sendJson(response, 200, config);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "ZD401")
          return sendProblem(response, 401, "unauthorized");
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}
