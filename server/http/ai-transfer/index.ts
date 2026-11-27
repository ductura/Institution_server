import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  eventTextBytes,
  isWorkId,
  parseAiTransferRecordV1Text,
  ROUTES,
  workIdFromPath,
} from "../../contracts/index.ts";
import { createAiTransfers, type WithActor } from "../../database/index.ts";
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

// POST /api/v1/works/{documentId}/ai-transfers (SRV-1809, Ductus#2059
// c.7208831876; evidence-segment-v4, step 3): the student who owns the work
// records a transfer from an answer of the assistant. The session decides who
// asks; assistant.create_ai_transfer decides whether the caller owns the work
// and the answer and whether the text is an exact part of it. Another's, an
// unknown and a malformed work or answer read the same 404 (C-23). The text is
// passed on as it came, never normalized (K14), and never logged or returned.
// The answer is the record the database wrote, read again against
// ductus-ai-transfer-v1 and its SHA-256: a record that does not read back is
// 503, never a 201 with a record a segment could not point at.
const contract = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const CREATE = contract("work.ai-transfer.post");
const CREATED_BODY = CREATE.responses.find((response) => response.status === 201)!.body!;

const BODY_TIMEOUT_MS = 5_000;

function jsonType(request: { headersDistinct: Record<string, string[] | undefined> }): boolean {
  const types = request.headersDistinct["content-type"];
  return (
    types?.length === 1 && types[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

function unavailable(response: ServerResponse, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), CREATE.id);
  sendProblem(response, 503, "unavailable");
}

function workOf(segment: string | undefined): string | null {
  const id = workIdFromPath(segment ?? "");
  return id !== null && isWorkId(id) ? id : null;
}

export function createAiTransferRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const transfers = createAiTransfers(withActor);
  return [
    {
      contract: CREATE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        if (!jsonType(request)) return refuse(response, 415, "unsupported_media_type");
        const raw = await readBodyWithLimit(request, CREATE.request.maxBodyBytes!, BODY_TIMEOUT_MS);
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(CREATE.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { responseId, text } = json.value as { responseId: string; text: string };
        // A lone surrogate has no UTF-8 spelling: the driver would send U+FFFD
        // and the substring check would run on another text than the hashed one.
        if (eventTextBytes(text) === null) return sendProblem(response, 422, "invalid_input");
        const documentId = workOf(params?.documentId);
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await transfers.create(token, documentId, responseId, text);
        if (result.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (result.status === "not_found") return sendProblem(response, 404, "not_found");
        if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "ok") return unavailable(response, new Error(result.status));
        const parsed = parseAiTransferRecordV1Text(result.recordText);
        if (
          !parsed.ok ||
          parsed.record.transferId !== result.transferId ||
          createHash("sha256").update(result.recordText, "utf8").digest("hex") !==
            result.recordSha256
        ) {
          return unavailable(response, new Error("ai transfer record does not read back"));
        }
        const body = {
          aiTransferId: result.transferId,
          aiTransferSha256: result.recordSha256,
          record: parsed.record,
        };
        if (!Value.Check(CREATED_BODY, body)) {
          return unavailable(response, new Error("invalid ai transfer answer"));
        }
        sendJson(response, 201, body);
      },
    },
  ];
}
