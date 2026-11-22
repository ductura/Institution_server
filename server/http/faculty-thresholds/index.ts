import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createFacultyThresholds,
  THRESHOLD_ORIGINS,
  type ThresholdOrigin,
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

// GET /api/v1/institution/origin-thresholds, PUT and DELETE
// /api/v1/institution/origin-thresholds/{origin} and GET
// /api/v1/works/{documentId}/origin-thresholds (SRV-1111, P-1 rule 12). The
// session decides who asks; the database decides who may: an account that is
// not a confirmed administrator of the institution is 403 on the first two,
// another's, an unknown or a malformed work is 404 on the comparison (C-23).
// A body the closed contract refuses, or one that names a kind twice, is 422.
// An answer outside the contract or a throw is 503 and reported, never a
// partial answer. The student and the teacher get the same bytes from the
// comparison, and it holds only the three words (in_line, for_review, exceeded).
const BODY_TIMEOUT_MS = 5_000;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((response) => response.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

function deleteContract(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return { contract };
}

/** The kind of origin of the path, or null when it is not on the closed list. */
function originOf(value: string | undefined): ThresholdOrigin | null {
  return THRESHOLD_ORIGINS.find((origin) => origin === value) ?? null;
}

export type FacultyThresholdRoutesOptions = {
  readonly withActor: WithActor;
  /** Session activity for an accepted write (session/recordActivity). */
  readonly recordActivity?: (token: string) => Promise<unknown>;
};

export function createFacultyThresholdRoutes({
  withActor,
  recordActivity: touch,
}: FacultyThresholdRoutesOptions): Route[] {
  const thresholds = createFacultyThresholds(withActor);
  const get = contractOf("institution.origin-thresholds.get");
  const put = contractOf("institution.origin-threshold.put");
  const del = deleteContract("institution.origin-threshold.delete");
  const compare = contractOf("work.origin-thresholds.get");
  const input = put.contract.request.body;
  if (input === undefined) throw new Error("no request body of institution.origin-threshold.put");

  function unavailable(response: Parameters<typeof sendProblem>[0], id: string, error: unknown) {
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  }

  const read: Route = {
    contract: get.contract,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
        return sendProblem(response, 422, "invalid_input");
      }
      const result = await thresholds.read(token);
      if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (result.status === "forbidden") return sendProblem(response, 403, "forbidden");
      if (result.status !== "ok")
        return unavailable(response, get.contract.id, new Error(result.status));
      const body = { thresholds: result.thresholds };
      if (!Value.Check(get.body, body)) {
        return unavailable(response, get.contract.id, new Error("answer outside the contract"));
      }
      sendJson(response, 200, body);
    },
  };

  const replace: Route = {
    contract: put.contract,
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
        put.contract.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      const origin = originOf(params?.origin);
      if (origin === null || !Value.Check(input, json.value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const value = json.value as { thresholdPercent: number; strictness: "hard" | "soft" };
      const result = await thresholds.put(token, { origin, ...value });
      if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (result.status === "forbidden") return sendProblem(response, 403, "forbidden");
      if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
      if (result.status !== "ok")
        return unavailable(response, put.contract.id, new Error(result.status));
      const body = { changed: result.changed };
      if (!Value.Check(put.body, body)) {
        return unavailable(response, put.contract.id, new Error("answer outside the contract"));
      }
      if (touch !== undefined) void touch(token).catch(() => undefined);
      sendJson(response, 200, body);
    },
  };

  const remove: Route = {
    contract: del.contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const origin = originOf(params?.origin);
      if (origin === null) return sendProblem(response, 422, "invalid_input");
      const result = await thresholds.clear(token, origin);
      if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (result.status === "forbidden") return sendProblem(response, 403, "forbidden");
      if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
      if (result.status !== "ok")
        return unavailable(response, del.contract.id, new Error(result.status));
      if (touch !== undefined) void touch(token).catch(() => undefined);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    },
  };

  const comparison: Route = {
    contract: compare.contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return sendProblem(response, 404, "not_found");
      const result = await thresholds.compare(token, documentId);
      if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (result.status === "forbidden" || result.status === "invalid") {
        return sendProblem(response, 404, "not_found");
      }
      if (result.status !== "ok") {
        return unavailable(response, compare.contract.id, new Error(result.status));
      }
      const body = { comparison: result.comparison };
      if (!Value.Check(compare.body, body)) {
        return unavailable(response, compare.contract.id, new Error("answer outside the contract"));
      }
      sendJson(response, 200, body);
    },
  };

  return [read, replace, remove, comparison];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createFacultyThresholdRoutesFor(main: { withActor: WithActor }): Route[] {
  return createFacultyThresholdRoutes({
    withActor: main.withActor,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
