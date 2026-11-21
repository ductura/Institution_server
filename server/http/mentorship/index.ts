import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createMentorshipRequestStore, type WithActor } from "../../database/index.ts";
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

// SRV-1407: the moves of one mentorship request. Not being allowed and not
// existing read the same 404, so a caller learns nothing about a request that
// is not theirs, another institution's included.
const find = (id: string) => ROUTES.find((route) => route.id === id)!;
const REQUEST = find("mentorship.requests.post");
const APPROVE = find("mentorship.request-approve.post");
const DECLINE = find("mentorship.request-decline.post");
const WITHDRAW = find("mentorship.request-withdraw.post");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [404, "not_found"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
  ["ZD503", [503, "unavailable"]],
]);

type Store = ReturnType<typeof createMentorshipRequestStore>;
type Body = { teacherId?: string; workType?: string; reason?: string };

async function answer(
  store: Store,
  contract: typeof REQUEST,
  token: string,
  requestId: string,
  body: Body,
) {
  if (contract === REQUEST) {
    const id = await store.request(token, body.teacherId!.toLowerCase(), body.workType!);
    return { requestId: id, state: "requested" };
  }
  if (contract === APPROVE) {
    const mentorshipId = await store.approve(token, requestId);
    return { requestId, state: "approved", mentorshipId };
  }
  if (contract === DECLINE) {
    await store.decline(token, requestId, body.reason ?? null);
    return { requestId, state: "declined" };
  }
  await store.withdraw(token, requestId);
  return { requestId, state: "withdrawn" };
}

export function createMentorshipRequestRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createMentorshipRequestStore(withActor);
  return [REQUEST, APPROVE, DECLINE, WITHDRAW].map((contract) => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        let requestId = "";
        if (contract !== REQUEST) {
          const raw = params?.requestId ?? "";
          if (!ID.test(raw)) return refuse(response, 404, "not_found");
          requestId = raw.toLowerCase();
        }

        let body: Body = {};
        if (contract.request.body !== undefined) {
          const types = request.headersDistinct["content-type"];
          if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
            return refuse(response, 415, "unsupported_media_type");
          }
          const raw = await readBodyWithLimit(
            request,
            contract.request.maxBodyBytes!,
            BODY_TIMEOUT_MS,
          );
          if (!raw.ok) return refuse(response, raw.status, raw.reason);
          const json = parseJson(raw.bytes);
          if (!json.ok) return sendProblem(response, 400, "invalid_json");
          if (!Value.Check(contract.request.body, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          body = json.value as Body;
        }

        try {
          const result = await answer(store, contract, token, requestId, body);
          if (!Value.Check(success.body!, result)) throw new Error("invalid mentorship answer");
          sendJson(response, success.status, result);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    };
  });
}
