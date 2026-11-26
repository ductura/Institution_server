// GET /api/v1/teacher/questionnaires/{id}/export (SRV-V18-UPITNIK-IZVOZ;
// contract teacher.questionnaire-export.get): a teacher of the course reads the
// answers of a questionnaire as questionnaire-export-v1. The session decides who
// asks, the database whether the relation holds (the questionnaire store,
// migration 20261219380000); a student, another course's teacher, an unknown and
// a malformed id all read the same 404 (C-23). The query is checked here:
// includeText is only "true" or "false", any other value or parameter is 422
// before the database. Fewer sheets than the least number is 409 and nothing is
// returned. The export carries no person and no time; it is checked against its
// contract before it leaves, and an answer outside it is 503.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createQuestionnaireStore, type WithActor } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return contract;
}
const EXPORT = contractOf("teacher.questionnaire-export.get");
const EXPORT_BODY = (() => {
  const body = EXPORT.responses.find((r) => r.status === 200)?.body;
  if (body === undefined) throw new Error(`no body ${EXPORT.id}`);
  return body;
})();

export type QuestionnaireExportPort = Pick<ReturnType<typeof createQuestionnaireStore>, "exportOf">;

/** The refusals the database functions give, by code; anything else is a failure (503). */
function refusalOf(error: unknown): 401 | 404 | 409 | 422 | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZD401") return 401;
  if (code === "ZD404" || code === "ZD403") return 404;
  if (code === "ZD409") return 409;
  if (code === "ZD422") return 422;
  return undefined;
}

const PROBLEM = {
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
  422: "invalid_input",
} as const;

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

/** includeText: null when the query is not exactly nothing, includeText=true or includeText=false. */
function includeTextOf(request: IncomingMessage): boolean | null {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const keys = [...query.keys()];
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== "includeText" || query.getAll("includeText").length !== 1) {
    return null;
  }
  const value = query.get("includeText");
  return value === "true" ? true : value === "false" ? false : null;
}

function sendProblemFor(response: ServerResponse, error: unknown, id: string): void {
  const status = refusalOf(error);
  if (status !== undefined) return sendProblem(response, status, PROBLEM[status]);
  reportServerError("route", error, requestIdOf(response), id);
  sendProblem(response, 503, "unavailable");
}

export function createQuestionnaireExportRoutes(port: QuestionnaireExportPort): Route[] {
  return [
    {
      contract: EXPORT,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const segment = params?.id;
        if (segment === undefined || !UUID.test(segment)) {
          return sendProblem(response, 404, "not_found");
        }
        const includeText = includeTextOf(request);
        if (includeText === null) return sendProblem(response, 422, "invalid_input");
        try {
          const result = await port.exportOf(token, segment.toLowerCase(), includeText);
          if (!result.ok) return sendProblem(response, 409, "conflict");
          if (Value.Check(EXPORT_BODY, result.export)) {
            response.setHeader("cache-control", "no-store");
            return sendJson(response, 200, result.export);
          }
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            EXPORT.id,
          );
          sendProblem(response, 503, "unavailable");
        } catch (error) {
          sendProblemFor(response, error, EXPORT.id);
        }
      },
    },
  ];
}

/** The route over main's application withActor. */
export function createQuestionnaireExportRoutesFor(main: { withActor: WithActor }): Route[] {
  return createQuestionnaireExportRoutes(createQuestionnaireStore(main.withActor));
}
