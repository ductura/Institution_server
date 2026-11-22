// GET and POST /api/v1/institution/faculty-rules (institution.faculty-rules.get
// and institution.faculty-rules.post, SRV-2001). The caller comes only from
// the session. An account that is not a confirmed administrator of the
// institution is 403, a body the closed contract refuses is 422 with the code
// of its field, a stale basedOnVersionNo is 409, an answer outside the
// contract or a throw is 503 and reported, never a partial answer. The origin
// layer checks the POST before it gets here.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import {
  facultyRuleRefusal,
  publishFacultyRule,
  readFacultyRules,
  type FacultyRuleInput,
} from "../../institution/index.ts";
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
const GET_ID = "institution.faculty-rules.get";
const POST_ID = "institution.faculty-rules.post";

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200 || r.status === 201)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

export type FacultyRuleRoutesOptions = {
  readonly withActor: WithActor;
  /** Session activity for an accepted write (session/recordActivity). */
  readonly recordActivity?: (token: string) => Promise<unknown>;
};

/** The two routes over one application withActor. */
export function createFacultyRuleRoutes({
  withActor,
  recordActivity: touch,
}: FacultyRuleRoutesOptions): Route[] {
  const get = contractOf(GET_ID);
  const post = contractOf(POST_ID);
  const input = post.contract.request.body;
  if (input === undefined) throw new Error(`no request body of ${POST_ID}`);

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
      try {
        const result = await readFacultyRules(token, withActor);
        if (result.kind === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.kind === "notFound") return sendProblem(response, 403, "forbidden");
        if (result.kind === "ok") {
          const answer = { rules: result.rules };
          if (Value.Check(get.body, answer)) return sendJson(response, 200, answer);
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            GET_ID,
          );
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GET_ID);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };

  const publish: Route = {
    contract: post.contract,
    async handle(request, response) {
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
        post.contract.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      // The closed schema, then the field that names why it is refused.
      const refusal = facultyRuleRefusal(json.value);
      if (refusal !== null || !Value.Check(input, json.value)) {
        return sendProblem(response, 422, refusal ?? "invalid_input");
      }
      try {
        const outcome = await publishFacultyRule(token, json.value as FacultyRuleInput, withActor);
        switch (outcome.kind) {
          case "unauthorized":
            return sendProblem(response, 401, "unauthorized");
          case "forbidden":
            return sendProblem(response, 403, "forbidden");
          case "conflict":
            return sendProblem(response, 409, "conflict");
          case "invalid":
            return sendProblem(response, 422, "invalid_input");
          case "unavailable":
            return sendProblem(response, 503, "unavailable");
          case "ok": {
            const answer = { versionNo: outcome.versionNo, publishedAt: outcome.publishedAt };
            if (Value.Check(post.body, answer)) {
              if (touch !== undefined) void touch(token).catch(() => undefined);
              return sendJson(response, 201, answer);
            }
            reportServerError(
              "route",
              new Error("answer outside the contract"),
              requestIdOf(response),
              POST_ID,
            );
          }
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), POST_ID);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };

  return [read, publish];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createFacultyRuleRoutesFor(main: { withActor: WithActor }): Route[] {
  return createFacultyRuleRoutes({
    withActor: main.withActor,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
