// SRV-MENTOR-2: the thin HTTP adapter over createThesisStore. The database
// decides access; this file checks the frame and the shape of each request and
// maps the RPC errors (ZD401..ZD422) to the closed words of the contract.
import { Value } from "@sinclair/typebox/value";

import {
  MentorConsentInput,
  ThesisFormCode,
  ThesisFormInput,
  ThesisSettingInput,
  ThesisStageInput,
  thesisRoutes,
  workIdFromPath,
  WorkThesisFormInput,
} from "../../contracts/index.ts";
import { createThesisStore, type WithActor } from "../../database/index.ts";
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
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
  // A date PostgreSQL refuses (out of range, malformed after the pattern).
  ["22007", [422, "invalid_input"]],
  ["22008", [422, "invalid_input"]],
]);

type Contract = (typeof thesisRoutes)[number];

function refusalOf(contract: Contract, code: unknown): readonly [number, string] | undefined {
  const refusal = ERRORS.get(code);
  if (refusal === undefined) return undefined;
  // A route answers only the errors of its contract; anything else is a fault.
  return contract.errors.some((spec) => spec.status === refusal[0] && spec.code === refusal[1])
    ? refusal
    : undefined;
}

/** defense_scheduled needs the date; none and submitted_to_office take none. */
function stageIsConsistent(stage: string, defenseAt: string | undefined): boolean {
  if (stage === "defense_scheduled") return defenseAt !== undefined;
  if (stage === "none" || stage === "submitted_to_office") return defenseAt === undefined;
  return true;
}

export function createThesisRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createThesisStore(main.withActor);
  return thesisRoutes.map((contract: Contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      let documentId: string | null = null;
      if (contract.path.includes("{documentId}")) {
        documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return refuse(response, 404, "not_found");
      }
      let code: string | undefined;
      if (contract.path.includes("{code}")) {
        code = params?.code ?? "";
        if (!Value.Check(ThesisFormCode, code)) return refuse(response, 404, "not_found");
      }

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
        const body = await answer(contract, token, documentId ?? "", code ?? "", json);
        if (body === null) return sendProblem(response, 422, "invalid_input");
        const success = contract.responses[0];
        if (!Value.Check(success.body, body)) throw new Error("invalid thesis result");
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
    code: string,
    json: unknown,
  ): Promise<unknown> {
    switch (contract.id) {
      case "institution.thesis-forms.get":
        return store.forms(token);
      case "institution.thesis-forms.post":
        if (!Value.Check(ThesisFormInput, json)) return null;
        if (new Set(json.workTypes).size !== json.workTypes.length) return null;
        return store.publishForm(token, json);
      case "institution.thesis-settings.get":
        return store.setting(token);
      case "institution.thesis-settings.put":
        if (!Value.Check(ThesisSettingInput, json)) return null;
        return store.setSetting(token, json.mentorConsentRequired);
      case "work.thesis-forms.get":
        return store.workForms(token, documentId);
      case "work.thesis-form.put":
        if (!Value.Check(WorkThesisFormInput, json)) return null;
        return store.setWorkForm(token, documentId, code, json.state);
      case "work.mentor-consent.get":
        return store.consent(token, documentId);
      case "work.mentor-consent.put":
        if (!Value.Check(MentorConsentInput, json)) return null;
        return store.setConsent(token, documentId, json.given, json.comment ?? null);
      case "work.thesis-stage.get":
        return store.stage(token, documentId);
      case "work.thesis-stage.put":
        if (!Value.Check(ThesisStageInput, json)) return null;
        if (!stageIsConsistent(json.stage, json.defenseAt)) return null;
        return store.setStage(token, documentId, json.stage, json.defenseAt ?? null);
    }
  }
}
