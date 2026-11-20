import { Value } from "@sinclair/typebox/value";
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createConsultationRecords,
  type ConsultationRecords,
  type WithActor,
} from "../../database/index.ts";
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

const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const LIST = contract("work.consultation-records.get");
const CREATE = contract("work.consultation-records.post");
const ADD = contract("work.consultation-additions.post");

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BIDI = /[‪-‮⁦-⁩]/u;

/** NFC, no control character but newline and tab, no bidirectional control: the server's part of the text rule. */
function isCleanText(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !/\p{Cc}/u.test(value.replace(/[\n\t]/gu, "")) &&
    !BIDI.test(value)
  );
}

type Refusal = "unauthenticated" | "not_found" | "invalid_input" | "unavailable";

function refusal(response: ServerResponse, status: Refusal): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "invalid_input") return sendProblem(response, 422, "invalid_input");
  sendProblem(response, 503, "unavailable");
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

/** The work id of the path, or null: one that is not a work id is the same 404 as another's work (C-23). */
function workOf(segment: string | undefined): string | null {
  const id = workIdFromPath(segment ?? "");
  return id !== null && isWorkId(id) ? id : null;
}

/** The checked JSON body of a write, or null once the answer has been sent. */
async function bodyOf(
  request: Parameters<Route["handle"]>[0],
  response: ServerResponse,
  contractRoute: typeof CREATE,
): Promise<Record<string, unknown> | null> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return null;
  }
  const raw = await readBodyWithLimit(
    request,
    contractRoute.request.maxBodyBytes!,
    BODY_TIMEOUT_MS,
  );
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return null;
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return null;
  }
  if (!Value.Check(contractRoute.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return null;
  }
  return json.value as Record<string, unknown>;
}

export function createConsultationRecordRoutes(records: ConsultationRecords): Route[] {
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        try {
          const answer = await records.list(token, documentId);
          if (answer.status !== "ok") return refusal(response, answer.status);
          sendJson(response, 200, { records: answer.records });
        } catch (error) {
          unavailable(response, LIST.id, error);
        }
      },
    },
    {
      contract: CREATE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const body = await bodyOf(request, response, CREATE);
        if (body === null) return;
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const { heldOn, revision, topic, agreement } = body as {
          heldOn: string;
          revision: number;
          topic: string;
          agreement: string;
        };
        if (!isCleanText(topic) || !isCleanText(agreement)) {
          return sendProblem(response, 422, "invalid_input");
        }
        try {
          const answer = await records.create(token, documentId, {
            heldOn,
            revision,
            topic,
            agreement,
          });
          if (answer.status !== "ok") return refusal(response, answer.status);
          sendJson(response, 201, answer.record);
        } catch (error) {
          unavailable(response, CREATE.id, error);
        }
      },
    },
    {
      contract: ADD,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const body = await bodyOf(request, response, ADD);
        if (body === null) return;
        const documentId = workOf(params?.documentId);
        const recordId = params?.recordId;
        if (documentId === null || recordId === undefined || !UUID.test(recordId)) {
          return sendProblem(response, 404, "not_found");
        }
        const text = body.text as string;
        if (!isCleanText(text)) return sendProblem(response, 422, "invalid_input");
        try {
          const answer = await records.addAddition(token, documentId, recordId, text);
          if (answer.status !== "ok") return refusal(response, answer.status);
          sendJson(response, 201, answer.addition);
        } catch (error) {
          unavailable(response, ADD.id, error);
        }
      },
    },
  ];
}

/** The routes over main's application withActor. */
export function createConsultationRecordRoutesFor(main: { withActor: WithActor }): Route[] {
  return createConsultationRecordRoutes(createConsultationRecords(main.withActor));
}
