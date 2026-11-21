// GET /api/v1/institution/config (institution.config.get) and
// POST /api/v1/institution/config/versions (institution.config-versions.post),
// SRV-1406: the HTTP edge of the versioned rules of an institution. The rules
// themselves, who may and the audit row are the database's (SRV-1405 and
// migration 20261202190600); the caller comes only from the session. The
// origin layer checks the POST before it gets here. A teacher or a student is
// 403, rules the closed schema refuses are 422, a stale expectedVersion is
// 409, an answer outside the contract or a throw is 503 and the throw is
// reported, never a partial answer.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createInstitutionConfigStore,
  type InstitutionConfigStore,
  type InstitutionConfigVersion,
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
const GET_ID = "institution.config.get";
const POST_ID = "institution.config-versions.post";

type Sent = {
  expectedVersion: number;
  citationStyle: "fpzg";
  workLanguages: ("hr" | "en")[];
  defaultWorkLanguage: "hr" | "en";
};

const shown = (v: InstitutionConfigVersion) => ({
  version: v.version,
  effectiveFrom: v.createdAt,
  rules: v.rules,
});

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200 || r.status === 201)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

export type InstitutionConfigRoutesOptions = {
  readonly store: InstitutionConfigStore;
  /** Session activity for an accepted write (session/recordActivity). */
  readonly recordActivity?: (token: string) => Promise<unknown>;
};

/** The two routes over one port. */
export function createInstitutionConfigRoutes({
  store,
  recordActivity: touch,
}: InstitutionConfigRoutesOptions): Route[] {
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
        const result = await store.versions(token);
        if (result.status !== "ok") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 403, "forbidden");
        }
        const versions = result.versions.map(shown);
        const answer = { current: versions.at(-1) ?? null, versions };
        if (Value.Check(get.body, answer)) return sendJson(response, 200, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          GET_ID,
        );
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
      if (!Value.Check(input, json.value)) return sendProblem(response, 422, "invalid_input");
      const sent = json.value as Sent;
      try {
        const outcome = await store.publish(token, sent.expectedVersion, {
          citationStyle: sent.citationStyle,
          workLanguages: sent.workLanguages,
          defaultWorkLanguage: sent.defaultWorkLanguage,
        });
        if (outcome.status !== "ok") {
          switch (outcome.status) {
            case "unauthorized":
              return sendProblem(response, 401, "unauthorized");
            case "forbidden":
              return sendProblem(response, 403, "forbidden");
            case "conflict":
              return sendProblem(response, 409, "conflict");
            case "invalid_input":
              return sendProblem(response, 422, "invalid_input");
          }
        }
        // The version is stored and never changes: its moment comes from the chain.
        const chain = await store.versions(token);
        const stored =
          chain.status === "ok"
            ? chain.versions.find((v) => v.version === outcome.version)
            : undefined;
        if (stored !== undefined) {
          const answer = shown(stored);
          if (Value.Check(post.body, answer)) {
            if (touch !== undefined) void touch(token).catch(() => undefined);
            return sendJson(response, 201, answer);
          }
        }
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          POST_ID,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), POST_ID);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };

  return [read, publish];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createInstitutionConfigRoutesFor(main: { withActor: WithActor }): Route[] {
  return createInstitutionConfigRoutes({
    store: createInstitutionConfigStore(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
