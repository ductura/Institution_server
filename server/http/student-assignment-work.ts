// GET /api/v1/student/assignment-work (DAN-1084-1; contract Ductus#2028
// c.6967448047) over the reader of DAN-989-2a: the state of the caller's own
// work per assignment. Who asks comes only from the session cookie (Ductus
// liveSessionToken, as profile-interface-locale.ts); no query, header or other
// cookie reaches the reader. A read, so it counts no session activity. The
// contract declares no 403, so Sec-Fetch-Site is not checked here (open
// question on Ductus#2028). Mounted by DAN-1084-2.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createMyAssignmentWorkReader, type MyAssignmentWorkReader } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}
const CONTRACT = contractOf("student.assignment-work.get");
const BODY = CONTRACT.responses[0]!.body;

/** An own field of an item, never one from its prototype. */
const own = (item: unknown, key: string): unknown =>
  typeof item === "object" && item !== null && Object.hasOwn(item, key)
    ? (item as Record<string, unknown>)[key]
    : undefined;

/**
 * The 200 body from the two named own fields of each item, or null when the
 * value is no array or the body is not what the contract's closed schema
 * allows: nothing else a reader answers ever leaves. Items are read by index
 * as own elements, never through a method or iterator of the value (review
 * FAIL c.6968017042), and the first hole or field outside the schema ends it.
 */
function bodyOf(value: unknown): { assignments: unknown[] } | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  const assignments: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = own(value, String(index));
    const work = { assignmentId: own(item, "assignmentId"), workState: own(item, "workState") };
    if (typeof BODY !== "object" || !Value.Check(BODY, { assignments: [work] })) return null;
    assignments.push(work);
  }
  const body = { assignments };
  return typeof BODY === "object" && Value.Check(BODY, body) ? body : null;
}

export type StudentAssignmentWorkRouteOptions = { readonly reader: MyAssignmentWorkReader };

/** The one reader code with its own answer; every other code is 503 unavailable. */
const UNAUTHENTICATED = "MY_ASSIGNMENT_WORK_UNAUTHENTICATED";

/** The route over a reader; a 200 body is built here from two named own fields only. */
export function createStudentAssignmentWorkRoute(
  options: StudentAssignmentWorkRouteOptions,
): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const read = await options.reader.read(token);
        if (!read.ok) {
          return read.error.code === UNAUTHENTICATED
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 503, "unavailable");
        }
        const body = bodyOf(read.value);
        if (body === null) throw new TypeError("assignment work outside the contract");
        sendJson(response, 200, body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor (mounted by server/server.ts in DAN-1084-2). */
export function createStudentAssignmentWorkRouteFor(
  main: Pick<Databases["main"], "withActor">,
): Route {
  return createStudentAssignmentWorkRoute({
    reader: createMyAssignmentWorkReader(main.withActor),
  });
}
