import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createConsultationSlotStore, type WithActor } from "../../database/index.ts";
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

const LIST = ROUTES.find((route) => route.id === "work.consultation-slots.get")!;
const REQUEST = ROUTES.find((route) => route.id === "work.consultation-slots.post")!;
const TRANSITION = ROUTES.find((route) => route.id === "work.consultation-slots.patch")!;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
  ["22007", [422, "invalid_input"]],
  ["22008", [422, "invalid_input"]],
  ["22009", [422, "invalid_input"]],
]);

type Input = { action?: "confirm" | "counter" | "accept"; startsAt?: string; topic?: string };

export function createConsultationSlotRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createConsultationSlotStore(withActor);
  return [LIST, REQUEST, TRANSITION].map((contract) => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        const slotId = params?.slotId;
        if (
          documentId === null ||
          !Value.Check(contract.request.params!, {
            documentId,
            ...(slotId === undefined ? {} : { slotId }),
          })
        ) {
          return refuse(response, 404, "not_found");
        }

        let input: Input = {};
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
          input = json.value as Input;
        }

        try {
          let body: unknown;
          if (contract === LIST) {
            body = { slots: await store.list(token, documentId) };
          } else {
            const rows =
              contract === REQUEST
                ? await store.request(token, documentId, input.startsAt!, input.topic ?? null)
                : await store.transition(
                    token,
                    documentId,
                    slotId!,
                    input.action!,
                    input.startsAt ?? null,
                  );
            if (rows.length !== 1) throw new Error("expected one consultation slot");
            body = rows[0];
          }
          if (!Value.Check(success.body!, body))
            throw new Error("invalid consultation slot response");
          sendJson(response, success.status, body);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
        if (contract !== LIST) void recordActivity(token, withActor).catch(() => undefined);
      },
    };
  });
}
