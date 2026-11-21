// GET and POST /api/v1/institution/legal-holds and POST
// /api/v1/institution/legal-holds/{holdId}/release (SRV-1306, plan M10.3;
// contracts institution.legal-holds.get, institution.legal-holds.post and
// institution.legal-hold-release.post) over the legal holds of SRV-1305. The
// HTTP edge only: who may do what (an administrator of the institution; never
// the one who placed a hold releasing it) is the database's. The mutations go
// through the shared origin layer and the JSON body reader. A body or id the
// contract does not accept is 422 (a path id that is no UUID is 404, as the
// hold cannot exist); an answer outside the contract, or a throw, is 503 and
// the throw is reported, never a partial answer.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createLegalHolds, type LegalHolds, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import { reportServerError } from "../error-catalog.ts";
import { INSTITUTION_BODY_TIMEOUT_MS, readInstitutionJson } from "../institution-courses.ts";
import { sendProblem } from "../problem.ts";
import { requestIdOf } from "../request-id.ts";
import { type Route, sendJson } from "../router.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200 || r.status === 201)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["conflict", [409, "conflict"]],
  ["invalid", [422, "invalid_input"]],
] as const);

const refusalOf = (status: string): readonly [number, string] =>
  REFUSALS.get(status) ?? [503, "unavailable"];

export type LegalHoldRouteOptions = {
  readonly holds: LegalHolds;
  /** Session activity for an accepted mutation (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

function listRoute({ holds }: LegalHoldRouteOptions): Route {
  const { contract, body } = contractOf("institution.legal-holds.get");
  return {
    contract,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const result = await holds.list(token);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { holds: result.holds };
        if (Value.Check(body, answer)) return sendJson(response, 200, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

function placeRoute(options: LegalHoldRouteOptions): Route {
  const { contract, body } = contractOf("institution.legal-holds.post");
  const input = contract.request.body!;
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      const read = await readInstitutionJson(
        request,
        response,
        [],
        contract.request.maxBodyBytes!,
        timeoutMs,
      );
      if (read === null) return;
      if (!Value.Check(input, read.value)) return sendProblem(response, 422, "invalid_input");
      const sent = read.value as { subjectType: string; subjectId: string; caseReference: string };
      try {
        const result = await options.holds.place(read.token, {
          subjectType: sent.subjectType,
          subjectId: sent.subjectId,
          caseReference: sent.caseReference,
        });
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { holdId: result.holdId };
        if (Value.Check(body, answer)) {
          sendJson(response, 201, answer);
          void options.recordActivity(read.token).catch(() => undefined);
          return;
        }
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

function releaseRoute(options: LegalHoldRouteOptions): Route {
  const { contract, body } = contractOf("institution.legal-hold-release.post");
  const input = contract.request.body!;
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response, params) {
      const read = await readInstitutionJson(
        request,
        response,
        [],
        contract.request.maxBodyBytes!,
        timeoutMs,
      );
      if (read === null) return;
      const holdId = params?.holdId ?? "";
      if (!UUID.test(holdId)) return sendProblem(response, 404, "not_found");
      if (!Value.Check(input, read.value)) return sendProblem(response, 422, "invalid_input");
      const { reason } = read.value as { reason: string };
      try {
        const result = await options.holds.release(read.token, holdId.toLowerCase(), reason);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { holdId: result.holdId, releasedAt: result.releasedAt };
        if (Value.Check(body, answer)) {
          sendJson(response, 200, answer);
          void options.recordActivity(read.token).catch(() => undefined);
          return;
        }
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The three routes over one port: the list, the placing, the release. */
export function createLegalHoldRoutes(options: LegalHoldRouteOptions): Route[] {
  return [listRoute(options), placeRoute(options), releaseRoute(options)];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createLegalHoldRoutesFor(main: { withActor: WithActor }): Route[] {
  return createLegalHoldRoutes({
    holds: createLegalHolds(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
