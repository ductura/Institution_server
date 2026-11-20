import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { readSettingsValues, settingsCatalogue } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  type Databases,
  reportServerError,
  requestIdOf,
  type Route,
  sendJson,
  sendProblem,
} from "../index.ts";

const CONTRACTS = (() => {
  const catalogue = ROUTES.find((route) => route.id === "settings.catalogue.get");
  const values = ROUTES.find((route) => route.id === "settings.values.get");
  const querySchema = values?.request.query;
  const responseSchema = values?.responses.find((response) => response.status === 200)?.body;
  if (
    catalogue === undefined ||
    values === undefined ||
    querySchema === undefined ||
    responseSchema === undefined
  ) {
    throw new Error("missing settings read contracts");
  }
  return { catalogue, values, querySchema, responseSchema };
})();

type Main = Pick<Databases["main"], "actorReader" | "withActor">;
const REFUSALS = { 401: "unauthorized", 404: "not_found", 422: "invalid_input" } as const;

export function createSettingsReadRoutes(main: Main): readonly Route[] {
  const { catalogue, values, querySchema, responseSchema } = CONTRACTS;
  return [
    {
      contract: catalogue,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        try {
          const actor = await main.actorReader.currentActor(token);
          if (actor.userId === null) return sendProblem(response, 401, "unauthorized");
          sendJson(response, 200, settingsCatalogue);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), catalogue.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    },
    {
      contract: values,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const target = request.url ?? "";
        const start = target.indexOf("?");
        const params = new URLSearchParams(start < 0 ? "" : target.slice(start + 1));
        const query = Object.fromEntries(params);
        const { level, course } = query;
        if (
          params.size !== Object.keys(query).length ||
          !Value.Check(querySchema, query) ||
          level === undefined ||
          (level === "course") !== (course !== undefined)
        )
          return sendProblem(response, 422, "invalid_input");

        try {
          const result = await readSettingsValues(main.withActor, token, level, course ?? null);
          if (result.status !== 200)
            return sendProblem(response, result.status, REFUSALS[result.status]);
          if (!Value.Check(responseSchema, result.body))
            throw new Error("invalid settings values response");
          sendJson(response, 200, result.body);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), values.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}
