// GET /api/v1/analysis/catalogue and POST /api/v1/analysis/runs
// (analysis.catalogue.get and analysis.runs.post, SRV-V15-HTTP; val 15,
// docs/nalazi/val15-razlika.md §3, §4 t. 6). A thin HTTP adapter over the pure
// domain (runAnalysis): a live session (401), the media type (415), the
// bounded body (413), its JSON (400) and its shape (422). It writes nothing: no
// table, no stored run, and neither the dataset nor the result reaches a log or
// an error. The only database call is the read of the session. The switch is
// off by default and is changed only by the owner's PR (the constant below);
// while it is off both routes answer 404 not_found as if they did not exist.
// Local exception: analysisEnabledFor (variable plus local stack marker only).
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  ANALYSIS_DOMAIN_IDS,
  analysisSpecOf,
  DATASET_LIMITS,
  createMyAccountReader,
  runAnalysis,
  type WithActor,
} from "../../database/index.ts";
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

/** The switch of the function (OC-style): off for the pilot, changed only by the owner's PR. */
export const ANALYSIS_ENABLED = false;

/** The variable that asks for the local exception (never a default, never set in a deployment). */
export const ANALYSIS_LOCAL_VARIABLE = "DUCTUS_ANALYSIS_LOCAL";

/**
 * The local exception (SRV-ANALIZA-LOKALNO, the owner's option b): the routes
 * answer only when the variable is exactly "1" AND the process carries the
 * local stack marker, the same one the other local-only fakes use: NODE_ENV
 * exactly "development", the fake OIDC provider, and no DUCTURA_DEPLOYMENT at
 * all (so never staging, never production). The constant above stays false.
 */
export function analysisEnabledFor(env: NodeJS.ProcessEnv): boolean {
  if (ANALYSIS_ENABLED) return true;
  return (
    env[ANALYSIS_LOCAL_VARIABLE] === "1" &&
    env.NODE_ENV === "development" &&
    env.DUCTUS_AUTH_PROVIDER === "fake-oidc" &&
    env.DUCTURA_DEPLOYMENT === undefined
  );
}

const find = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const CATALOGUE_CONTRACT = find("analysis.catalogue.get");
const RUNS_CONTRACT = find("analysis.runs.post");
const RUNS_BODY = RUNS_CONTRACT.request.body!;
const CATALOGUE_BODY = CATALOGUE_CONTRACT.responses.find((r) => r.status === 200)!.body!;
const RESULT_BODY = RUNS_CONTRACT.responses.find((r) => r.status === 200)!.body!;
const BODY_TIMEOUT_MS = 15_000;

const isJson = (types: string[] | undefined) =>
  types?.length === 1 && types[0]?.split(";")[0]?.trim().toLowerCase() === "application/json";

/** The catalogue: the registry's analyses and the domain's limits (equal to the contract's). */
function catalogue() {
  return {
    limits: {
      maxRows: DATASET_LIMITS.maxRows,
      maxColumns: DATASET_LIMITS.maxColumns,
      maxCellLength: DATASET_LIMITS.maxCellLength,
      maxBodyBytes: DATASET_LIMITS.maxBodyBytes,
    },
    analyses: ANALYSIS_DOMAIN_IDS.map((id) => {
      const spec = analysisSpecOf(id)!;
      return {
        id: spec.id,
        version: spec.version,
        variables: { kind: spec.variables.kind, min: spec.variables.min, max: spec.variables.max },
      };
    }),
  };
}

type Options = { readonly enabled?: boolean };

export function createAnalysisRoutesFor(
  { withActor }: { withActor: WithActor },
  { enabled = ANALYSIS_ENABLED }: Options = {},
): Route[] {
  const readAccount = createMyAccountReader(withActor);

  /** The live session, or the answer already sent. */
  async function session(
    request: Parameters<Route["handle"]>[0],
    response: Parameters<Route["handle"]>[1],
    contractId: string,
  ): Promise<boolean> {
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) {
      sendProblem(response, 401, "unauthorized");
      return false;
    }
    try {
      const account = await readAccount(token);
      if (account.ok) return true;
      sendProblem(response, 401, "unauthorized");
    } catch (error) {
      reportServerError("route", error, requestIdOf(response), contractId);
      sendProblem(response, 503, "unavailable");
    }
    return false;
  }

  const catalogueRoute: Route = {
    contract: CATALOGUE_CONTRACT,
    async handle(request, response) {
      if (!enabled) return sendProblem(response, 404, "not_found");
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      if (!(await session(request, response, CATALOGUE_CONTRACT.id))) return;
      const body = catalogue();
      if (!Value.Check(CATALOGUE_BODY, body)) {
        reportServerError(
          "route",
          new Error("catalogue differs from contract"),
          requestIdOf(response),
          CATALOGUE_CONTRACT.id,
        );
        return sendProblem(response, 503, "unavailable");
      }
      sendJson(response, 200, body);
    },
  };

  const runsRoute: Route = {
    contract: RUNS_CONTRACT,
    async handle(request, response) {
      if (!enabled) return sendProblem(response, 404, "not_found");
      if (!(await session(request, response, RUNS_CONTRACT.id))) return;
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        RUNS_CONTRACT.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(RUNS_BODY, json.value)) return sendProblem(response, 422, "invalid_input");
      try {
        const outcome = await runAnalysis(json.value);
        if (!outcome.ok) {
          return sendProblem(
            response,
            422,
            outcome.error.code === "unknown_analysis_version"
              ? "unknown_analysis_version"
              : "invalid_input",
          );
        }
        if (!Value.Check(RESULT_BODY, outcome.value)) throw new Error("invalid analysis result");
        sendJson(response, 200, outcome.value);
      } catch (error) {
        // The message names no cell: the error is the class and the route only.
        reportServerError("route", error, requestIdOf(response), RUNS_CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };

  return [catalogueRoute, runsRoute];
}
