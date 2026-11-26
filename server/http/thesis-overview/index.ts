// SRV-V16-POPIS-FAKULTET: the thin HTTP adapter over createThesisOverviewStore.
// The database decides access (the administrator of the faculty only); this
// file checks the query and maps the RPC errors (ZD401, ZD403, ZD422) to the
// closed words of the contract.
import { Value } from "@sinclair/typebox/value";

import {
  THESIS_OVERVIEW_DEFAULT_LIMIT,
  institutionThesisOverviewGet,
} from "../../contracts/index.ts";
import {
  createThesisOverviewStore,
  decodeThesisOverviewCursor,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import {
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const ERRORS = new Map<unknown, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD422", [422, "invalid_input"]],
]);

const KEYS = new Set(["stage", "limit", "after"]);

/** The query as the contract has it, or null: an unknown or repeated key, or a bad value. */
function queryOf(url: string | undefined) {
  const params = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  const keys = [...params.keys()];
  if (keys.some((key) => !KEYS.has(key)) || new Set(keys).size !== keys.length) return null;
  const query = Object.fromEntries(params);
  if (!Value.Check(institutionThesisOverviewGet.request.query, query)) return null;
  if (query.after !== undefined && decodeThesisOverviewCursor(query.after) === null) return null;
  return {
    stage: query.stage ?? null,
    limit: query.limit === undefined ? THESIS_OVERVIEW_DEFAULT_LIMIT : Number(query.limit),
    after: query.after ?? null,
  };
}

export function createThesisOverviewRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createThesisOverviewStore(main.withActor);
  const contract = institutionThesisOverviewGet;
  return [
    {
      contract,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const query = queryOf(request.url);
        try {
          // The database answers who may read before the query is judged, so a
          // caller who is no administrator reads 403 whatever the query is.
          const body = await store.overview(token, query ?? { stage: null, limit: 1, after: null });
          if (query === null) return sendProblem(response, 422, "invalid_input");
          const success = contract.responses[0];
          if (!Value.Check(success.body, body)) throw new Error("invalid thesis overview result");
          return sendJson(response, success.status, body);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = ERRORS.get(code);
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}
