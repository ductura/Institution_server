import { Value } from "@sinclair/typebox/value";

import { KeyDatesBody, KeyDatesParams, keyDatesGet } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

import { readKeyDates } from "./read.ts";

export function createKeyDatesRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  return [
    {
      contract: keyDatesGet,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        if (!Value.Check(KeyDatesParams, params)) return sendProblem(response, 404, "not_found");
        try {
          const result = await readKeyDates(withActor, token, params.id);
          if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (!Value.Check(KeyDatesBody, result.body))
            throw new Error("invalid key dates response");
          return sendJson(response, 200, result.body);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), keyDatesGet.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}
