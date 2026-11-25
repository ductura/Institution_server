// GET and PUT /api/v1/teacher/courses/{courseId}/assistant and
// GET /api/v1/student/assignments/{assignmentId}/assistant (SRV-ASIST-PREKIDAC;
// contracts teacher.course-assistant.get, teacher.course-assistant.put and
// student.assignment-assistant.get): a teacher of the course reads and sets the
// switch "Asistent uključen", a student of an assignment reads whether the
// assistant is available for it. Available is (a) the server has a provider,
// decided here, and (b) a published cost configuration and (c) the course's
// switch on, decided by the database. The session decides who asks, the
// database whether the relation holds; anyone else, an unknown and a malformed
// id read the same 404 (C-23). Every answer is checked against its contract.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createCourseAssistantPort,
  type CourseAssistantPort,
  type WithActor,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { PRODUCTION_ASSISTANT_PROVIDER } from "./assistant/index.ts";
import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}
const READ = contractOf("teacher.course-assistant.get");
const SET = contractOf("teacher.course-assistant.put");
const AVAILABLE = contractOf("student.assignment-assistant.get");

const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

type Result =
  | { readonly status: "read"; readonly answer: Record<string, boolean> }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

/** The outcome on the wire: 401, 404, 422, else the checked answer. */
function send(response: ServerResponse, { contract, body }: typeof READ, result: Result): void {
  if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
  if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
  if (result.status !== "read") return sendProblem(response, 404, "not_found");
  if (Value.Check(body, result.answer)) return sendJson(response, 200, result.answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  sendProblem(response, 503, "unavailable");
}

async function guarded(
  response: ServerResponse,
  id: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  }
}

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

export type CourseAssistantRouteDeps = {
  readonly port: CourseAssistantPort;
  /** (a): the server has a provider; the same value the request route uses. */
  readonly providerPresent: boolean;
};

export function createCourseAssistantRoutes({
  port,
  providerPresent,
}: CourseAssistantRouteDeps): Route[] {
  const switched = async (run: Promise<Awaited<ReturnType<CourseAssistantPort["read"]>>>) => {
    const result = await run;
    return result.status === "read"
      ? { status: "read" as const, answer: { enabled: result.enabled } }
      : result;
  };
  return [
    {
      contract: READ.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const courseId = idOf(params?.courseId);
        if (courseId === null) return sendProblem(response, 404, "not_found");
        await guarded(response, READ.contract.id, async () =>
          send(response, READ, await switched(port.read(token, courseId))),
        );
      },
    },
    {
      contract: SET.contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          SET.contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(SET.contract.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const courseId = idOf(params?.courseId);
        if (courseId === null) return sendProblem(response, 404, "not_found");
        const { enabled } = json.value as { enabled: boolean };
        await guarded(response, SET.contract.id, async () =>
          send(response, SET, await switched(port.set(token, courseId, enabled))),
        );
      },
    },
    {
      contract: AVAILABLE.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = idOf(params?.assignmentId);
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        await guarded(response, AVAILABLE.contract.id, async () => {
          // The relation is checked even without a provider: a stranger reads 404.
          const result = await port.available(token, assignmentId);
          send(
            response,
            AVAILABLE,
            result.status === "read"
              ? {
                  status: "read",
                  answer: { assistantEnabled: providerPresent && result.available },
                }
              : result,
          );
        });
      },
    },
  ];
}

/**
 * The three routes over main's application withActor. (a) is the provider the
 * production request route has (PRODUCTION_ASSISTANT_PROVIDER), so the two
 * never disagree.
 */
export function createCourseAssistantRoutesFor(main: { withActor: WithActor }): Route[] {
  return createCourseAssistantRoutes({
    port: createCourseAssistantPort(main.withActor),
    providerPresent: PRODUCTION_ASSISTANT_PROVIDER !== null,
  });
}
