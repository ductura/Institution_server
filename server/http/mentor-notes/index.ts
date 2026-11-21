import { Value } from "@sinclair/typebox/value";

import {
  MentorNoteInput,
  MentorshipNoteParams,
  mentorNotesGet,
  mentorNotesPost,
} from "../../contracts/index.ts";
import { createMentorNotesStore, type WithActor } from "../../database/index.ts";
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

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

export function createMentorNotesRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createMentorNotesStore(withActor);
  return [mentorNotesGet, mentorNotesPost].map((contract) => ({
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (
        contract === mentorNotesGet &&
        site !== undefined &&
        (site.length !== 1 || site[0] !== "same-origin")
      ) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const input = { id: params?.id ?? "" };
      if (!Value.Check(MentorshipNoteParams, input)) return refuse(response, 404, "not_found");
      const id = input.id.toLowerCase();
      try {
        let body;
        if (contract === mentorNotesGet) {
          const result = await store.read(token, id);
          if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          body = { notes: result.notes };
        } else {
          const types = request.headersDistinct["content-type"];
          if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
            return refuse(response, 415, "unsupported_media_type");
          }
          const raw = await readBodyWithLimit(
            request,
            mentorNotesPost.request.maxBodyBytes!,
            BODY_TIMEOUT_MS,
          );
          if (!raw.ok) return refuse(response, raw.status, raw.reason);
          const json = parseJson(raw.bytes);
          if (!json.ok) return sendProblem(response, 400, "invalid_json");
          if (!Value.Check(MentorNoteInput, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          body = await store.create(token, id, json.value.body);
        }
        const success = contract.responses[0]!;
        if (!Value.Check(success.body!, body)) throw new Error("invalid mentor notes result");
        sendJson(response, success.status, body);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ZD401") return sendProblem(response, 401, "unauthorized");
        if (code === "ZD403") return sendProblem(response, 404, "not_found");
        if (contract === mentorNotesPost && code === "ZD422") {
          return sendProblem(response, 422, "invalid_input");
        }
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
