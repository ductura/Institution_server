import { Value } from "@sinclair/typebox/value";
import type { ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createEventDisputes, type EventDisputes, type WithActor } from "../../database/index.ts";
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
const LIST = contract("work.event-disputes.get");
const ADD = contract("work.event-disputes.post");

const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;

/** NFC, no control character but newline and tab, no bidirectional control: the server's part of the text rule. */
function isCleanText(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !/\p{Cc}/u.test(value.replace(/[\n\t]/gu, "")) &&
    !BIDI.test(value)
  );
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

export function createEventDisputeRoutes(disputes: EventDisputes): Route[] {
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        try {
          const answer = await disputes.listForWork(token, documentId);
          if (answer.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
          if (answer.status === "not_found") return sendProblem(response, 404, "not_found");
          sendJson(response, 200, {
            disputes: answer.records.map((record) => ({
              disputeId: record.id,
              kind: record.kind,
              eventId: record.eventId,
              text: record.text,
              createdAt: record.createdAt,
            })),
          });
        } catch (error) {
          unavailable(response, LIST.id, error);
        }
      },
    },
    {
      contract: ADD,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(request, ADD.request.maxBodyBytes!, BODY_TIMEOUT_MS);
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(ADD.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { kind, eventId, text } = json.value as {
          kind: string;
          eventId: string;
          text: string;
        };
        if (!isCleanText(text)) return sendProblem(response, 422, "invalid_input");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        try {
          const answer = await disputes.addToWork(token, documentId, { kind, eventId, text });
          if (answer.status === "added") {
            return sendJson(response, 201, {
              disputeId: answer.record.id,
              createdAt: answer.record.createdAt,
            });
          }
          if (answer.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
          if (answer.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
          // Not the owner. A reader of the work (who may read its records) is told
          // 403; anyone else, and a work that does not exist, the same 404 (C-23).
          const reader = await disputes.listForWork(token, documentId);
          if (reader.status === "read") return sendProblem(response, 403, "forbidden");
          sendProblem(response, 404, "not_found");
        } catch (error) {
          unavailable(response, ADD.id, error);
        }
      },
    },
  ];
}

/** The routes over main's application withActor. */
export function createEventDisputeRoutesFor(main: { withActor: WithActor }): Route[] {
  return createEventDisputeRoutes(createEventDisputes(main.withActor));
}
