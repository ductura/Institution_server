// GET /api/v1/student/questionnaires, GET /api/v1/student/questionnaires/{id},
// POST /api/v1/student/questionnaires/{id}/responses and POST
// /api/v1/teacher/questionnaires/{id}/responses/manual (SRV-V18-UPITNIK-
// ISPUNJAVANJE; contracts student.questionnaires.get, student.questionnaire.get,
// student.questionnaire-responses.post and
// teacher.questionnaire-manual-responses.post): a student of the course reads
// the open questionnaires and answers one once, a teacher of the course enters
// a sheet by hand. The session decides who asks, the database whether the
// relation holds (the questionnaire store, migration 20261219380000); another's,
// an unknown, a malformed and, for a student, a not open questionnaire all read
// the same 404 (C-23). The sheet carries no person: this adapter never sends
// the person next to the answers, and the store stores them apart. Every answer
// is checked against its contract; a body outside it is 422 before the database.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createQuestionnaireStore, type WithActor } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The contract (OpenAPI) bounds a text answer with maxLength, which counts UTF-16
// units; the domain and the database count Unicode code points. The body is
// therefore checked here with a code-point bound (same error, 422), so a text of
// 2000 code points with an emoji is not refused. The contract schema is not
// changed (a changed schema would break clients).
const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
const BODY = Type.Object(
  {
    answers: Type.Array(
      Type.Object(
        {
          questionId: Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          }),
          value: Type.Union([
            Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}` }),
            Type.Number(),
            Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
              minItems: 1,
              maxItems: 20,
            }),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 40 },
    ),
  },
  { additionalProperties: false },
);

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return contract;
}
const LIST = contractOf("student.questionnaires.get");
const FORM = contractOf("student.questionnaire.get");
const SUBMIT = contractOf("student.questionnaire-responses.post");
const MANUAL = contractOf("teacher.questionnaire-manual-responses.post");

const bodyOf = (contract: ReturnType<typeof contractOf>) => {
  const body = contract.responses.find((r) => r.status === 200)?.body;
  if (body === undefined) throw new Error(`no body ${contract.id}`);
  return body;
};
const LIST_BODY = bodyOf(LIST);
const FORM_BODY = bodyOf(FORM);

export type QuestionnaireResponsesPort = ReturnType<typeof createQuestionnaireStore>;

const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

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

async function guarded(
  response: ServerResponse,
  id: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const status = refusalOf(error);
    if (status !== undefined) return sendProblem(response, status, PROBLEM[status]);
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  }
}

function sendChecked(
  response: ServerResponse,
  contractId: string,
  body: Parameters<typeof Value.Check>[0],
  answer: unknown,
): void {
  if (Value.Check(body, answer)) return sendJson(response, 200, answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contractId,
  );
  sendProblem(response, 503, "unavailable");
}

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

type Answers = { answers: { questionId: string; value: unknown }[] };

/** The write handler of both POST routes: guard, body, contract, then `store`. */
function writeRoute(
  contract: typeof SUBMIT,
  store: (token: string, id: string, answers: Answers["answers"]) => Promise<void>,
): Route {
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      // A malformed id is 404 whatever the body is (C-23), so it is read first.
      const id = idOf(params?.id);
      if (id === null) return sendProblem(response, 404, "not_found");
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(BODY, json.value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      await guarded(response, contract.id, async () => {
        await store(token, id, (json.value as Answers).answers);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      });
    },
  };
}

export function createQuestionnaireResponsesRoutes(port: QuestionnaireResponsesPort): Route[] {
  return [
    {
      contract: LIST,
      async handle(request, response) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        await guarded(response, LIST.id, async () =>
          sendChecked(response, LIST.id, LIST_BODY, {
            questionnaires: (await port.listForStudent(token)).map((item) => ({
              id: item.id,
              courseId: item.courseId,
              title: item.title,
              participated: item.participated,
            })),
          }),
        );
      },
    },
    {
      contract: FORM,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const id = idOf(params?.id);
        if (id === null) return sendProblem(response, 404, "not_found");
        await guarded(response, FORM.id, async () => {
          const form = await port.readForStudent(token, id);
          sendChecked(response, FORM.id, FORM_BODY, {
            id: form.id,
            courseId: form.courseId,
            title: form.title,
            participated: form.participated,
            questions: form.questions,
          });
        });
      },
    },
    writeRoute(SUBMIT, (token, id, answers) => port.submit(token, id, answers)),
    writeRoute(MANUAL, (token, id, answers) => port.enterByHand(token, id, answers)),
  ];
}

/** The four routes over main's application withActor. */
export function createQuestionnaireResponsesRoutesFor(main: { withActor: WithActor }): Route[] {
  return createQuestionnaireResponsesRoutes(createQuestionnaireStore(main.withActor));
}
