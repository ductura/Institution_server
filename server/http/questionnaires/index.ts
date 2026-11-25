// SRV-V18-UPITNIK-AUTOR (Ductus#2058, val 18): the HTTP edge of the questionnaires of a course for
// its teacher: list, make, read, change a draft, open and close. Who may is the database's, from
// the relation (the teacher of the course); the institution and the author come from the session,
// never from the body. A student, a teacher of another course, another institution, an unknown
// and a malformed id are the same 404. A step the state does not allow (a change of an open
// questionnaire, opening twice) is 409 conflict. A title or a list of questions the domain or the
// database refuses is 422 invalid_input; a body outside the contract is 422 before any round trip.
// An answer outside the contract or a throw is 503 and the throw is reported. Nothing here reads
// an answer sheet: the sheets carry no person and belong to SRV-V18-UPITNIK-ISPUNJAVANJE.
import { Value } from "@sinclair/typebox/value";

import { questionnaireRoutes } from "../../contracts/index.ts";
import {
  createQuestionnaireStore,
  type QuestionnaireForm,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";
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

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const ERRORS = new Map<unknown, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD404", [404, "not_found"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

type Sent = {
  title: string;
  questions: Parameters<ReturnType<typeof createQuestionnaireStore>["create"]>[3];
};

export function createQuestionnaireRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createQuestionnaireStore(main.withActor);
  return questionnaireRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const id = params?.id ?? params?.courseId ?? "";
        if (!UUID.test(id)) return sendProblem(response, 404, "not_found");
        try {
          let json: unknown;
          if (contract.method !== "GET") {
            json = await jsonBody(request, response, contract.request.maxBodyBytes!);
            if (json === undefined) return;
            if (!Value.Check(contract.request.body!, json) || hasNul(json)) {
              return sendProblem(response, 422, "invalid_input");
            }
          }
          const body = await run(contract.id, store, token, id, json);
          if (success.body !== undefined && !Value.Check(success.body, body)) {
            reportServerError(
              "route",
              new Error("answer outside the contract"),
              requestIdOf(response),
              contract.id,
            );
            return sendProblem(response, 503, "unavailable");
          }
          sendJson(response, success.status, body);
          // An accepted write counts as activity (session/activity.ts); reads and refusals do not.
          if (contract.method !== "GET") {
            void recordActivity(token, main.withActor).catch(() => undefined);
          }
          return;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = ERRORS.get(code);
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    };
  });
}

/** The store call of one route; a make or a change answers with the questionnaire as stored. */
async function run(
  route: string,
  store: ReturnType<typeof createQuestionnaireStore>,
  token: string,
  id: string,
  json: unknown,
): Promise<unknown> {
  switch (route) {
    case "teacher.questionnaires.get":
      return { questionnaires: await store.listForCourse(token, id) };
    case "teacher.questionnaires.post": {
      const sent = json as Sent;
      return shown(
        await store.read(token, await store.create(token, id, sent.title, sent.questions)),
      );
    }
    case "teacher.questionnaire.get":
      return shown(await store.read(token, id));
    case "teacher.questionnaire.patch": {
      const sent = json as Sent;
      return shown(
        await store.read(token, await store.update(token, id, sent.title, sent.questions)),
      );
    }
    case "teacher.questionnaire-state.post":
      return {
        id,
        state: await store.setState(token, id, (json as { state: "open" | "closed" }).state),
      };
    default:
      throw new Error(`no handler for ${route}`);
  }
}

/** The form without `participated`, which belongs to a student's view of it (a teacher has no part in it). */
function shown({ participated: _participated, ...form }: QuestionnaireForm) {
  return form;
}

/** PostgreSQL's jsonb refuses U+0000 before the database could judge the text: it is input outside the contract. */
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, inner]) => key.includes("\u0000") || hasNul(inner));
  }
  return false;
}

async function jsonBody(
  req: Parameters<Route["handle"]>[0],
  res: Parameters<Route["handle"]>[1],
  limit: number,
): Promise<unknown> {
  const types = req.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(res, 415, "unsupported_media_type");
    return undefined;
  }
  const raw = await readBodyWithLimit(req, limit, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(res, raw.status, raw.reason);
    return undefined;
  }
  const parsed = parseJson(raw.bytes);
  if (!parsed.ok) {
    sendProblem(res, 400, "invalid_json");
    return undefined;
  }
  return parsed.value;
}
