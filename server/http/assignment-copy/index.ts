// POST /api/v1/teacher/assignments/{assignmentId}/copy
// (teacher.assignment-copy.post), SRV-1904 (P-D4): the teacher of an
// assignment copies it into a course they teach. The HTTP edge only; the rules
// are the database's (server/database/assignment-copy, migration
// 20261202190400). The origin layer checks the POST before it gets here. A
// malformed, refused or unknown id is the same 404 (C-23); a body the contract
// does not accept is 422; an answer outside the contract, or a throw, is 503
// and the throw is reported, never a partial answer.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createAssignmentCopy, type AssignmentCopy, type WithActor } from "../../database/index.ts";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ID = "teacher.assignment-copy.post";

type Sent = { requestKey: string; courseId: string; opensAt?: string; dueAt?: string };

/** The route over one port. */
export function createAssignmentCopyRoute(port: AssignmentCopy): Route {
  const contract = ROUTES.find((route) => route.id === ID);
  const body = contract?.responses.find((r) => r.status === 201)?.body;
  const input = contract?.request.body;
  if (contract === undefined || body === undefined || input === undefined) {
    throw new Error(`no contract ${ID}`);
  }
  return {
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
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(input, json.value)) return sendProblem(response, 422, "invalid_input");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      const sent = json.value as Sent;
      try {
        const result = await port.copy(token, {
          assignmentId: assignmentId.toLowerCase(),
          courseId: sent.courseId.toLowerCase(),
          requestKey: sent.requestKey.toLowerCase(),
          opensAt: sent.opensAt ?? null,
          dueAt: sent.dueAt ?? null,
        });
        switch (result.status) {
          case "unauthorized":
            return sendProblem(response, 401, "unauthorized");
          case "not_found":
            return sendProblem(response, 404, "not_found");
          case "conflict":
            return sendProblem(response, 409, "conflict");
          case "invalid_input":
            return sendProblem(response, 422, "invalid_input");
          case "copied": {
            const answer = { id: result.id, versionNo: 1 };
            if (Value.Check(body, answer)) return sendJson(response, 201, answer);
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
  };
}

/** The route over main's application withActor. */
export function createAssignmentCopyRouteFor(main: { withActor: WithActor }): Route {
  return createAssignmentCopyRoute(createAssignmentCopy(main.withActor));
}
