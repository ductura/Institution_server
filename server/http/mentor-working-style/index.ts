import { Value } from "@sinclair/typebox/value";

import {
  MentorWorkingStyleInput,
  MentorWorkingStyleParams,
  mentorWorkingStyleGet,
  mentorWorkingStylePut,
} from "../../contracts/index.ts";
import { createMentorWorkingStyleStore, type WithActor } from "../../database/index.ts";
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

// F4-MEN-R09-SRV: the mentor writes the own "Kako mentor radi" text, a student
// of the mentor reads it. The database decides who may. For the read every
// refusal is the same 404 (C-23), a malformed id included.
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

export function createMentorWorkingStyleRoutesFor({
  withActor,
}: {
  withActor: WithActor;
}): Route[] {
  const store = createMentorWorkingStyleStore(withActor);
  return [mentorWorkingStyleGet, mentorWorkingStylePut].map((contract) => ({
    contract,
    async handle(request, response, params) {
      const reading = contract === mentorWorkingStyleGet;
      const site = request.headersDistinct["sec-fetch-site"];
      if (reading && site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      try {
        let body;
        if (reading) {
          const input = { teacherId: params?.teacherId ?? "" };
          if (!Value.Check(MentorWorkingStyleParams, input)) {
            return refuse(response, 404, "not_found");
          }
          body = await store.read(token, input.teacherId.toLowerCase());
        } else {
          const types = request.headersDistinct["content-type"];
          if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
            return refuse(response, 415, "unsupported_media_type");
          }
          const raw = await readBodyWithLimit(
            request,
            mentorWorkingStylePut.request.maxBodyBytes!,
            BODY_TIMEOUT_MS,
          );
          if (!raw.ok) return refuse(response, raw.status, raw.reason);
          const json = parseJson(raw.bytes);
          if (!json.ok) return sendProblem(response, 400, "invalid_json");
          if (!Value.Check(MentorWorkingStyleInput, json.value)) {
            return sendProblem(response, 422, "invalid_input");
          }
          body = await store.set(token, json.value.text);
        }
        const success = contract.responses[0]!;
        if (!Value.Check(success.body!, body)) throw new Error("invalid mentor working style");
        sendJson(response, success.status, body);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ZD401") return sendProblem(response, 401, "unauthorized");
        if (code === "ZD403") {
          return reading
            ? sendProblem(response, 404, "not_found")
            : sendProblem(response, 403, "forbidden");
        }
        if (!reading && code === "ZD422") return sendProblem(response, 422, "invalid_input");
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
