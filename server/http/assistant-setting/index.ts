// GET /api/v1/institution/assistant-setting (institution.assistant-setting.get,
// SRV-ADMIN-3; NF-7 OA-9, OC-1). A confirmed administrator of the institution
// reads the assistant setting of its faculty; nothing here changes it. The
// caller comes only from the session; an account that is not a confirmed
// administrator is 403, any query is 422, an answer outside the contract or a
// throw is 503 and reported, never a partial answer.
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { assistantSettingGet } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { readFacultyAiSettings } from "../../external/assistant-tools/index.ts";
import { readAssistantSetting, type AssistantSettingSource } from "../../institution/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

export type AssistantSettingRouteOptions = {
  readonly withActor: WithActor;
  readonly source: AssistantSettingSource;
};

export function createAssistantSettingRoute({
  withActor,
  source,
}: AssistantSettingRouteOptions): Route {
  const body = assistantSettingGet.responses[0].body;
  return {
    contract: assistantSettingGet,
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
        const result = await readAssistantSetting(token, withActor, source);
        if (result.kind === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.kind === "notFound") return sendProblem(response, 403, "forbidden");
        if (result.kind === "ok") {
          if (Value.Check(body, result.setting)) return sendJson(response, 200, result.setting);
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            assistantSettingGet.id,
          );
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), assistantSettingGet.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/**
 * The route over main's withActor and the faculty settings in config/faculties,
 * read once here. `assistant` is false as in createAssistantRoutesFor: this
 * composition loads no provider configuration (Q-10); the composition that
 * loads one passes true. server/server.ts mounts it.
 */
export function createAssistantSettingRouteFor(main: { withActor: WithActor }): Route {
  const settings = readFacultyAiSettings(resolve("config/faculties"));
  return createAssistantSettingRoute({
    withActor: main.withActor,
    source: {
      assistant: false,
      switchOf: (slug) => {
        const setting = settings.settingOf(slug);
        return setting === null
          ? null
          : {
              version: setting.version,
              transcription: setting.aiSwitch.transcription,
              tools: setting.aiSwitch.tools,
            };
      },
    },
  });
}
