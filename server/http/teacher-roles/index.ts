// SRV-ULOGA-POTVRDA-OPOZIV (Ductus#2058): the handlers of
// POST /api/v1/institution/teachers/{teacherId}/role-confirmation and
// …/role-revocation (institution.role-confirmation.post,
// institution.role-revocation.post), exactly as their contracts stand. Port of
// the HTTP edge of Ductus teacher-role-confirmation-route.ts and
// teacher-role-revocation-route.ts (server/institution, PENDING here) in the
// form of the institution course routes: the session cookie (401), the path id
// a UUID (422), the media type (415), the bounded body (413, 408, 400), strict
// JSON (400), then exactly {} (422); origin is pipeline step 7. The body
// carries nothing: the person comes only from the path, the caller and the
// institution only from the session.
//
// Who may is the existing SECURITY DEFINER RPC's (migration
// 20261102220000_teacher_role_event.sql): only a confirmed, unrevoked
// administrator of the caller's institution, ZD403 for anyone else. Each RPC
// writes its one audit.teacher_role_event row in the same statement as the
// change, and a call that changes nothing writes nothing, so a repeated
// request is answered the same and leaves one audit row.
//
// Confirmation reads first, in the same transaction, whether the caller is a
// signed-in administrator (403 otherwise). Only then does a ZD403 of the RPC
// mean "no such candidate here", and every such reason (themself, another
// institution's person, a missing one, one whose last login gave no right) is
// the same 404. Revocation answers revoked false for a person who holds no
// active confirmed teacher role in the caller's institution, so another
// institution's person looks the same as a missing one. A log line carries the
// route and the error, never the id.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { recordActivity } from "../../session/index.ts";

import {
  decodeOnce,
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

export const CONFIRMATION_ID = "institution.role-confirmation.post";
export const REVOCATION_ID = "institution.role-revocation.post";

const CALLER_SQL = `SELECT a.user_id AS "userId", institution.actor_has_role('admin') AS admin FROM app.current_actor() a`;
const CONFIRM_SQL = "SELECT institution.confirm_teacher_role($1)";
const REVOKE_SQL = "SELECT institution.revoke_teacher_role($1) AS revoked";

export type TeacherRoleRouteOptions = {
  readonly withActor: WithActor;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** What a route answers: a 200 body built here, or a closed refusal. */
type Answer =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: number; readonly code: string };

const REFUSED = {
  unauthorized: { ok: false, status: 401, code: "unauthorized" },
  forbidden: { ok: false, status: 403, code: "forbidden" },
  notFound: { ok: false, status: 404, code: "not_found" },
} as const satisfies Record<string, Answer>;

/** The SQLSTATE of a database error, or undefined. */
function codeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** A non-null object, not an array, with no own enumerable key (Ductus readEmptyMutation). */
const isEmptyObject = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

/** The caller from one snapshot: no session (401), not an administrator (403), or one. */
async function callerOf(tx: ActorTransaction): Promise<"unauthorized" | "forbidden" | "admin"> {
  const { rows } = await tx.query<{ userId: unknown; admin: unknown }>(CALLER_SQL);
  if (rows.length > 1) throw new Error("invalid actor result");
  const row = rows[0];
  if (row?.userId === null || row?.userId === undefined) return "unauthorized";
  if (typeof row.admin !== "boolean") throw new Error("invalid actor result");
  return row.admin ? "admin" : "forbidden";
}

type Run = (token: string, teacherId: string) => Promise<Answer>;

function confirm(withActor: WithActor): Run {
  return async (token, teacherId) => {
    let administrator = false;
    try {
      return await withActor(token, async (tx): Promise<Answer> => {
        const caller = await callerOf(tx);
        if (caller !== "admin") return REFUSED[caller];
        administrator = true;
        const { rows } = await tx.query(CONFIRM_SQL, [teacherId]);
        if (rows.length !== 1) throw new Error("invalid teacher role confirmation result");
        return { ok: true, body: { confirmed: true } };
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD401") return REFUSED.unauthorized;
      // After the caller was read as an administrator, the RPC's refusal is
      // a candidate this institution cannot confirm: one answer for all.
      if (code === "ZD403") return administrator ? REFUSED.notFound : REFUSED.forbidden;
      throw error;
    }
  };
}

function revoke(withActor: WithActor): Run {
  return async (token, teacherId) => {
    try {
      const revoked = await withActor(token, async (tx) => {
        const { rows } = await tx.query<{ revoked: unknown }>(REVOKE_SQL, [teacherId]);
        const outcome = rows[0]?.revoked;
        if (rows.length !== 1 || typeof outcome !== "boolean") {
          throw new Error("invalid teacher role revocation result");
        }
        return outcome;
      });
      return { ok: true, body: { revoked } };
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD401") return REFUSED.unauthorized;
      if (code === "ZD403") return REFUSED.forbidden;
      throw error;
    }
  };
}

/** The two teacher role mutations of the institution administrator. */
export function createTeacherRoleRoutes(options: TeacherRoleRouteOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;

  const route = (id: string, run: Run): Route => {
    const contract = ROUTES.find((found) => found.id === id)!;
    const success = contract.responses.find((answer) => answer.status === 200)!.body!;
    const maxBytes = contract.request.maxBodyBytes ?? 64;
    return {
      contract,
      async handle(request, response, params) {
        const teacherId = decodeOnce(params?.teacherId);
        const input = await readInstitutionJson(
          request,
          response,
          [teacherId],
          maxBytes,
          timeoutMs,
        );
        if (input === null) return;
        if (!isEmptyObject(input.value)) return sendProblem(response, 422, "invalid_input");
        try {
          const answer = await run(input.token, teacherId.toLowerCase());
          if (!answer.ok) return sendProblem(response, answer.status, answer.code);
          if (!Value.Check(success, answer.body)) {
            throw new Error("teacher role answer outside its contract");
          }
          sendJson(response, 200, answer.body);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
        // Only an accepted answer counts, once written; a failure costs only the touch.
        void options.recordActivity(input.token).catch(() => undefined);
      },
    };
  };

  return [
    route(CONFIRMATION_ID, confirm(options.withActor)),
    route(REVOCATION_ID, revoke(options.withActor)),
  ];
}

/**
 * The routes over the main database: the RPCs and the activity touch both run
 * on main's application withActor. server/server.ts mounts them.
 */
export function createTeacherRoleRoutesFor(main: { readonly withActor: WithActor }): Route[] {
  return createTeacherRoleRoutes({
    withActor: main.withActor,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
