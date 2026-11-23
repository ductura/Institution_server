import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

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

import { ACTS, execute, type Action } from "./store.ts";

const CONTRACT = ROUTES.find((route) => route.id === "collaboration.comments.post")!;
const BODY = CONTRACT.request.body!;
const SUCCESS = CONTRACT.responses.find((response) => response.status === 200)!.body!;
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
const DB_REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

function isAction(value: string | undefined): value is Action {
  return value !== undefined && Object.hasOwn(ACTS, value);
}

export function createCollaborationCommentsRouteFor(main: { withActor: WithActor }): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      // The origin layer covers all six POST actions, including list.
      const action = params?.action;
      if (!isAction(action)) return refuse(response, 404, "not_found");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, CONTRACT.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(BODY, json.value)) return sendProblem(response, 422, "invalid_input");
      const input = json.value as Record<string, unknown>;
      const act: { keys: readonly string[]; optional?: readonly string[] } = ACTS[action];
      const { keys, optional = [] } = act;
      const extra = Object.keys(input).filter((key) => !keys.includes(key));
      if (
        !keys.every((key) => Object.hasOwn(input, key)) ||
        !extra.every((key) => optional.includes(key))
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      const body = input.body;
      if (
        typeof body === "string" &&
        (body !== body.normalize("NFC") ||
          /\p{Cc}/u.test(body.replace(/[\n\t]/gu, "")) ||
          BIDI.test(body))
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const result = await main.withActor(token, (tx) => execute(tx, action, input));
        if (result.status === 204) {
          response.writeHead(204, { "cache-control": "no-store" });
          return void response.end();
        }
        if (result.status === 409) return sendProblem(response, 409, "conflict");
        if (result.status === 422) return sendProblem(response, 422, "invalid_input");
        if (result.status === 200 && Value.Check(SUCCESS, result.body)) {
          return sendJson(response, 200, result.body);
        }
        reportServerError(
          "route",
          new Error("comment result unavailable"),
          requestIdOf(response),
          CONTRACT.id,
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = typeof code === "string" ? DB_REFUSALS.get(code) : undefined;
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}
