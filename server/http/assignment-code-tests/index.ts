// SRV-V21-KOD-TESTOVI-RUTA (Ductus#2058, val 21): the HTTP edge of the code tests of an
// assignment. A teacher of the assignment adds a revision; a teacher and a student of it read the
// latest. Who may is the database's; the institution, the author and the assignment come from the
// session and the path, never from the body. A student who writes is 403; everyone without a part
// in the assignment, another institution, an unknown and a malformed id are the same 404. More
// than 10 tests, a repeated id and tests the database finds too large are 422 invalid_code_tests;
// any other shape is 422 invalid_input. An answer outside the contract or a throw is 503 and the
// throw is reported. The server never runs the tests.
import { Value } from "@sinclair/typebox/value";

import {
  AssignmentCodeTestsInput,
  assignmentCodeTestsRoutes,
  CODE_TESTS_MAX,
} from "../../contracts/index.ts";
import {
  createAssignmentCodeTests,
  type StoredCodeTest,
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
  ["ZD403", [403, "forbidden"]],
  ["ZD404", [404, "not_found"]],
  ["ZD422", [422, "invalid_code_tests"]],
]);

export function createAssignmentCodeTestsRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createAssignmentCodeTests(main.withActor);
  return assignmentCodeTestsRoutes.map((contract): Route => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const assignmentId = params?.assignmentId ?? "";
        if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
        try {
          let body: unknown;
          if (contract.method === "GET") {
            body = await store.read(token, assignmentId);
          } else {
            const json = await jsonBody(request, response, contract.request.maxBodyBytes!);
            if (json === undefined) return;
            const refusal = inputRefusal(json);
            if (refusal !== undefined) return sendProblem(response, 422, refusal);
            const sent = json as { language: string; tests: StoredCodeTest[] };
            body = await store.publish(token, assignmentId, sent.language, sent.tests);
          }
          if (success.body !== undefined && !Value.Check(success.body, body)) {
            reportServerError(
              "route",
              new Error("answer outside the contract"),
              requestIdOf(response),
              contract.id,
            );
            return sendProblem(response, 503, "unavailable");
          }
          sendJson(response, 200, body);
          // An accepted write counts as activity (session/activity.ts); reads and refusals do not.
          if (contract.method === "PUT")
            void recordActivity(token, main.withActor).catch(() => undefined);
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

/** The 422 code for a body the route refuses, or undefined when it may go to the database. */
function inputRefusal(json: unknown): "invalid_input" | "invalid_code_tests" | undefined {
  const tests =
    json !== null && typeof json === "object" ? (json as { tests?: unknown }).tests : undefined;
  // The bound on the number of tests is its own refusal, whatever else the body holds.
  if (Array.isArray(tests) && tests.length > CODE_TESTS_MAX) return "invalid_code_tests";
  if (!Value.Check(AssignmentCodeTestsInput, json) || hasNul(json) || !allDefined(json)) {
    return "invalid_input";
  }
  const ids = (tests as { id: string }[]).map((test) => test.id);
  if (new Set(ids).size !== ids.length) return "invalid_code_tests";
  return undefined;
}

/** Every test names its input and its expected value, even when the value is null. */
function allDefined(json: unknown): boolean {
  const tests = (json as { tests: Record<string, unknown>[] }).tests;
  return tests.every((test) => "input" in test && "expected" in test);
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
