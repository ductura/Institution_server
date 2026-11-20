import type { ServerResponse } from "node:http";

import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import { createStudentNotes } from "../institution/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { sendJson, type Route } from "./router.ts";
import { refuse } from "./security-headers.ts";

const READ = ROUTES.find((route) => route.id === "student.submission-notes.get")!;
const ADD = ROUTES.find((route) => route.id === "student.submission-notes.post")!;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

function sendNoteRefusal(
  response: ServerResponse,
  code: "unauthorized" | "not_found" | "invalid_input",
): void {
  if (code === "unauthorized") return sendProblem(response, 401, code);
  if (code === "not_found") return sendProblem(response, 404, code);
  sendProblem(response, 422, code);
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

export function createStudentNotesRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const notes = createStudentNotes(withActor);
  return [
    {
      contract: READ,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = workIdFromPath(params?.assignmentId ?? "");
        if (assignmentId === null) return sendProblem(response, 404, "not_found");
        try {
          const result = await notes.read(token, assignmentId);
          if (result.status === "read") return sendJson(response, 200, { notes: result.notes });
          sendNoteRefusal(response, result.status);
        } catch (error) {
          unavailable(response, READ.id, error);
        }
      },
    },
    {
      contract: ADD,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          ADD.request.maxBodyBytes ?? 0,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        try {
          const result = await notes.add(token, json.value);
          if (result.status !== "added") {
            return sendNoteRefusal(response, result.status);
          }
          sendJson(response, 201, result.note);
        } catch (error) {
          return unavailable(response, ADD.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
  ];
}
