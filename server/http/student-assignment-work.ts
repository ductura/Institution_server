import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createMyAssignmentWorkReader,
  MY_ASSIGNMENT_WORK_UNAUTHENTICATED,
  type AssignmentWork,
  type MyAssignmentWorkReader,
  type WithActor,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { sendJson, type Route } from "./router.ts";

const CONTRACT = ROUTES.find((route) => route.id === "student.assignment-work.get")!;
const BODY = CONTRACT.responses.find((response) => response.status === 200)!.body;

type AssignmentWorkResponse =
  { status: 200; body: { assignments: AssignmentWork[] } } | { status: 401 | 503 };

function ownField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function assignmentWorkResponse(read: unknown): AssignmentWorkResponse {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(read);
  } catch {
    throw new Error("assignment work result not cloneable");
  }

  const ok = ownField(snapshot, "ok");
  if (ok === false) {
    const code = ownField(ownField(snapshot, "error"), "code");
    return { status: code === MY_ASSIGNMENT_WORK_UNAUTHENTICATED.code ? 401 : 503 };
  }
  if (ok !== true) return { status: 503 };

  const list = ownField(snapshot, "value");
  if (!Array.isArray(list)) return { status: 503 };
  let previousId = "";
  for (let index = 0; index < list.length; index += 1) {
    if (!Object.hasOwn(list, index)) return { status: 503 };
    const item: unknown = list[index];
    const id = ownField(item, "assignmentId");
    if (typeof id !== "string" || id <= previousId || ownField(item, "workState") === undefined) {
      return { status: 503 };
    }
    previousId = id;
  }

  const body = { assignments: list as AssignmentWork[] };
  if (typeof BODY !== "object" || !Value.Check(BODY, body)) return { status: 503 };

  // Keep serialization from consulting an inherited toJSON on the checked snapshot.
  for (const item of body.assignments) Object.setPrototypeOf(item, null);
  Object.setPrototypeOf(list, null);
  Object.setPrototypeOf(body, null);
  return { status: 200, body };
}

export function createStudentAssignmentWorkRoute(reader: MyAssignmentWorkReader): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");

      try {
        const answer = assignmentWorkResponse(await reader.read(token));
        if (answer.status === 200) return sendJson(response, 200, answer.body);
        if (answer.status === 401) return sendProblem(response, 401, "unauthorized");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
      }
      sendProblem(response, 503, "unavailable");
    },
  };
}

export function createStudentAssignmentWorkRouteFor(main: { withActor: WithActor }): Route {
  return createStudentAssignmentWorkRoute(createMyAssignmentWorkReader(main.withActor));
}
