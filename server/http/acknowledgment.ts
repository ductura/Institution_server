// POST /api/v1/institution/assignments/{assignmentId}/acknowledgment (contract
// institution.acknowledgment.post). Port of the HTTP edge of Ductus
// src/server/institution/acknowledgment-route.ts at 078c780 (DAN-306, #1502)
// over the port server/database/notice-acknowledgment.ts, in its order: the
// assignment id (400 invalid_assignment_id, before the session), the session
// token (401), Content-Type application/json with at most charset=utf-8
// (415), the body under 1 KiB and 5 s, strict UTF-8 JSON (400), then the body
// check with its exact text (422). Changes: origin is pipeline step 7; the
// token is liveSessionTokenFromCookie; the id is decoded once from the path;
// a leading byte order mark stays a character and fails the parse (Ductus
// read it away), as on every other route here (parseJson); an accepted
// acknowledgment counts as session activity once written (Ductus counted).
import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import { createNoticeAcknowledgments, type NoticeAcknowledgments } from "../database/index.ts";
import { NOTICE_TEMPLATE_VERSION, parseAcknowledgmentBody } from "../institution/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

export const ACKNOWLEDGMENT_BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ductus: application/json, with no parameter but charset=utf-8. */
const MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

export type AcknowledgmentRouteOptions = {
  readonly acknowledgments: NoticeAcknowledgments;
  /** The notice template version the RPC computes the fingerprint with. */
  readonly templateVersion: number;
  /** Session activity for an accepted acknowledgment (Ductus counted). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "institution.acknowledgment.post");
  if (found === undefined) throw new Error("no contract institution.acknowledgment.post");
  return found;
})();

/** The port's refusals; anything else is 503 unavailable. */
const REFUSAL: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["conflict", [409, "conflict"]],
  ["notice_changed", [409, "notice_changed"]],
]);

export function createAcknowledgmentRoute(options: AcknowledgmentRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? ACKNOWLEDGMENT_BODY_TIMEOUT_MS;
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const assignmentId = workIdFromPath(params?.assignmentId ?? "") ?? "";
      if (!UUID.test(assignmentId)) return refuse(response, 400, "invalid_assignment_id");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(
        request,
        CONTRACT.request.maxBodyBytes ?? 1024,
        timeoutMs,
      );
      if (!body.ok) return refuse(response, body.status, body.reason);
      const json = parseJson(body.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      const input = parseAcknowledgmentBody(json.text, json.value);
      if (input === null) return sendProblem(response, 422, "invalid_input");
      try {
        const outcome = await options.acknowledgments.acknowledge(token, {
          assignmentId,
          versionNo: input.versionNo,
          fingerprint: input.fingerprint,
          templateVersion: options.templateVersion,
        });
        if (outcome.status !== "acknowledged") {
          const [status, code] = REFUSAL.get(outcome.status) ?? [503, "unavailable"];
          return sendProblem(response, status, code);
        }
        sendJson(response, 200, { acknowledgedAt: outcome.acknowledgedAt });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted acknowledgment counts, once written; a failure costs only the touch.
      void options.recordActivity(token).catch(() => undefined);
    },
  };
}

/** The route over main's application withActor; server/server.ts mounts it. */
export function createAcknowledgmentRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createAcknowledgmentRoute({
    acknowledgments: createNoticeAcknowledgments(main.withActor),
    templateVersion: NOTICE_TEMPLATE_VERSION,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
