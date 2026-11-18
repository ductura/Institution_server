// GET /api/v1/student/assignment-work (DAN-1084-1b; contract Ductus#2028
// c.6967448047, scope c.6971571104) over the reader of DAN-989-2a: the state of the caller's own
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

/** The own field `key` of a non-null object, else undefined; never one from a prototype. */
const ownField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** An object item with both fields as its own, never from a prototype. */
const ownItem = (item: unknown): boolean =>
  typeof item === "object" &&
  item !== null &&
  Object.hasOwn(item, "assignmentId") &&
  Object.hasOwn(item, "workState");

/**
 * The 200 body from a snapshot of the reader's value, or null: no array, a
 * hole (an index the snapshot does not own, whatever a prototype carries
 * there), an item without its own two fields, or a body outside the
 * contract's closed schema. Nothing is read from the value itself.
 */
function bodyOf(snapshot: unknown): { assignments: unknown[] } | null {
  if (!Array.isArray(snapshot)) return null;
  for (let index = 0; index < snapshot.length; index += 1)
    if (!Object.hasOwn(snapshot, index) || !ownItem(snapshot[index])) return null;
  const body = { assignments: snapshot };
  return typeof BODY === "object" && Value.Check(BODY, body) ? body : null;
}

/**
 * The checked body with no prototype on the wrapper, the list or any item (QA FAIL
 * c.6973700421 on #317): JSON.stringify in writeJson then finds no inherited toJSON,
 * so what leaves is exactly what the schema checked. Own data is unchanged, and a
 * null-prototype array is still an array.
 */
function withoutPrototypes(body: { assignments: unknown[] }): { assignments: unknown[] } {
  const list = body.assignments;
  for (let index = 0; index < list.length; index += 1) Object.setPrototypeOf(list[index], null);
  Object.setPrototypeOf(list, null);
  const wrapper = { assignments: list };
  Object.setPrototypeOf(wrapper, null);
  return wrapper;
}

/** The snapshot, or one fixed Error (class other) whatever the clone threw. */
function snapshotOf<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error("reader result not cloneable");
  }
}

export type StudentAssignmentWorkRouteOptions = { readonly reader: MyAssignmentWorkReader };

/** The one reader code with its own answer; every other code is 503 unavailable. */
const UNAUTHENTICATED = "MY_ASSIGNMENT_WORK_UNAUTHENTICATED";

/** The route over a reader; a 200 body is only a snapshot that passed every check. */
export function createStudentAssignmentWorkRoute(
  options: StudentAssignmentWorkRouteOptions,
): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        // A snapshot, never the reader's own result (scope Ductus#2028 c.6971571104):
        // structuredClone throws on a Proxy, a function or a symbol value (and passes on
        // what a getter throws), drops symbol keys such as an own iterator and keeps
        // only own enumerable fields, never the prototype of an object.
        const read: unknown = snapshotOf(await options.reader.read(token));
        // ok, value, error and its code count only as own fields of the snapshot; a
        // snapshot that is no object is an answer like any other error: 503, no report.
        if (ownField(read, "ok") !== true) {
          return ownField(ownField(read, "error"), "code") === UNAUTHENTICATED
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 503, "unavailable");
        }
        const body = bodyOf(ownField(read, "value"));
        if (body === null) throw new TypeError("assignment work outside the contract");
        sendJson(response, 200, withoutPrototypes(body));
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
