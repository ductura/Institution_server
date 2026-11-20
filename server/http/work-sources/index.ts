import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath, WorkSourceRecord } from "../../contracts/index.ts";
import { createWorkSources, type WithActor, type WorkSourceInput } from "../../database/index.ts";
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

const LIST = ROUTES.find((route) => route.id === "student.work-sources.get")!;
const SAVE = ROUTES.find((route) => route.id === "student.work-sources.put")!;
const REMOVE = ROUTES.find((route) => route.id === "student.work-sources.delete")!;

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function pathId(segment: string | undefined, pattern = UUID): string | undefined {
  const id = workIdFromPath(segment ?? "");
  return id !== null && pattern.test(id) ? id : undefined;
}

type Refusal = "unauthorized" | "not_found" | "invalid_input";

function sendRefusal(response: ServerResponse, code: Refusal): void {
  if (code === "unauthorized") return sendProblem(response, 401, code);
  if (code === "not_found") return sendProblem(response, 404, code);
  sendProblem(response, 422, code);
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

export function createWorkSourceRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const workSources = createWorkSources(withActor);
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendRefusal(response, "unauthorized");
        const assignmentId = pathId(params?.assignmentId);
        if (assignmentId === undefined) return sendRefusal(response, "not_found");
        try {
          const result = await workSources.list(token, assignmentId, null);
          if (result.status !== "read") return sendRefusal(response, result.status);
          sendJson(response, 200, { sources: result.sources });
        } catch (error) {
          unavailable(response, LIST.id, error);
        }
      },
    },
    {
      contract: SAVE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          SAVE.request.maxBodyBytes ?? 0,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        const assignmentId = pathId(params?.assignmentId);
        const sourceId = pathId(params?.sourceId, SOURCE_ID);
        if (assignmentId === undefined || sourceId === undefined) {
          return sendRefusal(response, "not_found");
        }
        if (!Value.Check(SAVE.request.body!, json.value)) {
          return sendRefusal(response, "invalid_input");
        }
        const input = json.value as Omit<WorkSourceInput, "assignmentId">;
        if (!Value.Check(WorkSourceRecord, input.record) || input.record.id !== sourceId) {
          return sendRefusal(response, "invalid_input");
        }
        try {
          const result = await workSources.save(token, { ...input, assignmentId });
          if (result.status !== "saved") return sendRefusal(response, result.status);
          sendJson(response, 200, result.source);
        } catch (error) {
          return unavailable(response, SAVE.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
    {
      contract: REMOVE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const assignmentId = pathId(params?.assignmentId);
        const sourceId = pathId(params?.sourceId, SOURCE_ID);
        if (assignmentId === undefined || sourceId === undefined) {
          return sendRefusal(response, "not_found");
        }
        try {
          const { status } = await workSources.remove(token, assignmentId, sourceId);
          if (status !== "removed") {
            return sendRefusal(response, status === "absent" ? "not_found" : status);
          }
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } catch (error) {
          return unavailable(response, REMOVE.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
  ];
}
