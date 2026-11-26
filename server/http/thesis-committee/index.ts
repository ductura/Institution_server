// SRV-V16-POVJERENSTVO-ZAPIS: the thin HTTP adapter over createThesisCommitteeStore. The
// database decides access; this file checks the frame and the shape of each
// request and maps the RPC errors (ZD401..ZD422) to the closed words of the
// contract.
import { Value } from "@sinclair/typebox/value";

import {
  ThesisCommitteeInput,
  thesisCommitteeRoutes,
  workIdFromPath,
} from "../../contracts/index.ts";
import { createThesisCommitteeStore, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
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

const ERRORS = new Map<unknown, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD404", [404, "not_found"]],
  ["ZD422", [422, "invalid_input"]],
]);

type Contract = (typeof thesisCommitteeRoutes)[number];

function refusalOf(contract: Contract, code: unknown): readonly [number, string] | undefined {
  const refusal = ERRORS.get(code);
  if (refusal === undefined) return undefined;
  // A route answers only the errors of its contract; anything else is a fault.
  return contract.errors.some((spec) => spec.status === refusal[0] && spec.code === refusal[1])
    ? refusal
    : undefined;
}

export function createThesisCommitteeRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createThesisCommitteeStore(main.withActor);
  return thesisCommitteeRoutes.map((contract: Contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null) return refuse(response, 404, "not_found");

      let json: unknown;
      if (contract.method !== "GET") {
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const parsed = parseJson(raw.bytes);
        if (!parsed.ok) return sendProblem(response, 400, "invalid_json");
        json = parsed.value;
      }

      try {
        const body = await answer(contract, token, documentId, json);
        if (body === null) return sendProblem(response, 422, "invalid_input");
        const success = contract.responses[0];
        if (!Value.Check(success.body, body)) throw new Error("invalid thesis committee result");
        return sendJson(response, success.status, body);
      } catch (error) {
        const sqlCode =
          error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = refusalOf(contract, sqlCode);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  }));

  /** The success body, or null when the request body does not match the contract. */
  async function answer(
    contract: Contract,
    token: string,
    documentId: string,
    json: unknown,
  ): Promise<unknown> {
    switch (contract.id) {
      case "work.thesis-committee.get":
        return store.committee(token, documentId);
      case "work.thesis-committee.put":
        if (!Value.Check(ThesisCommitteeInput, json)) return null;
        return store.replace(token, documentId, json.members);
    }
  }
}
