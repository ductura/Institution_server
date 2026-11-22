// POST /api/v1/works/{documentId}/return-for-revision (work.return-for-revision.post),
// SRV-1606: the teacher returns the whole submitted work to the student for revision.
// The HTTP edge only; the rules are the database's (server/database/return-for-revision,
// migration 20261213100500). A malformed or unknown work id, and anybody who is not its
// teacher, is the same 404 (C-23); the student owner is 403; a work with no live
// submission 409; a body the contract does not accept 422; an answer outside the
// contract, or a throw, is 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createReturnForRevision, type WithActor } from "../../database/index.ts";
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

export function createReturnForRevisionRoutes(
  port: ReturnType<typeof createReturnForRevision>,
): Route[] {
  const contract = ROUTES.find((route) => route.id === "work.return-for-revision.post");
  const input = contract?.request.body;
  const answerSchema = contract?.responses.find((r) => r.status === 200)?.body;
  if (contract === undefined || input === undefined || answerSchema === undefined) {
    throw new Error("no contract work.return-for-revision.post");
  }
  return [
    {
      contract,
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
        const raw = await readBodyWithLimit(
          request,
          contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(input, json.value)) return sendProblem(response, 422, "invalid_input");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const sent = json.value as { comment: string; revisionDueAt?: string };
        try {
          const result = await port.returnWork(token, documentId, sent.comment, sent.revisionDueAt);
          switch (result.status) {
            case "unauthorized":
              return sendProblem(response, 401, "unauthorized");
            case "invalid":
              return sendProblem(response, 422, "invalid_input");
            case "not_found":
              return sendProblem(response, 404, "not_found");
            case "forbidden":
              return sendProblem(response, 403, "forbidden");
            case "not_submitted":
              return sendProblem(response, 409, "conflict");
            case "returned": {
              const answer = { ...result.value, state: "returned_for_revision" };
              if (Value.Check(answerSchema, answer)) return sendJson(response, 200, answer);
              reportServerError(
                "route",
                new Error("answer outside the contract"),
                requestIdOf(response),
                contract.id,
              );
            }
          }
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
        }
        return sendProblem(response, 503, "unavailable");
      },
    },
  ];
}

/** The route over main's application withActor. */
export function createReturnForRevisionRoutesFor(main: { withActor: WithActor }): Route[] {
  return createReturnForRevisionRoutes(createReturnForRevision(main.withActor));
}
