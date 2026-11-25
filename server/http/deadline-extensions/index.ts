// GET and POST /api/v1/teacher/assignments/{assignmentId}/deadline-extensions
// (teacher.deadline-extensions.get, teacher.deadline-extension.post), SRV-1108
// (Val 11, N-13, C-15): the teacher of an assignment lists its deadline
// extensions and records one for one student or for all. The HTTP edge only;
// the rules are the database's (server/database/deadline-extensions,
// migration 20261121106000). The origin layer checks the POST before it gets
// here. A malformed, refused or unknown id is the same 404 (C-23); a body the
// contract does not accept is 422; an answer outside the contract, or a throw,
// is 503 and the throw is reported, never a partial answer.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createDeadlineExtensions,
  type DeadlineExtensions,
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

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200 || r.status === 201)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

function listRoute(port: DeadlineExtensions): Route {
  const { contract, body } = contractOf("teacher.deadline-extensions.get");
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      try {
        const result = await port.list(token, assignmentId.toLowerCase());
        if (result.status !== "read") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = { extensions: result.extensions };
        if (Value.Check(body, answer)) return sendJson(response, 200, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

function addRoute(port: DeadlineExtensions): Route {
  const { contract, body } = contractOf("teacher.deadline-extension.post");
  const input = contract.request.body!;
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
      const sent = json.value as {
        scope: "one" | "all";
        studentId?: string;
        dueAt: string;
        reasonId: string;
      };
      try {
        const result = await port.add(token, {
          assignmentId: assignmentId.toLowerCase(),
          studentId: sent.scope === "one" ? (sent.studentId ?? "").toLowerCase() : null,
          dueAt: sent.dueAt,
          reasonId: sent.reasonId,
        });
        if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "added") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = {
          extension: result.extension,
          existingSubmissionsUnchanged: result.existingSubmissionsUnchanged,
        };
        if (Value.Check(body, answer)) return sendJson(response, 201, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

// SRV-NF4-IZNIMKA-ZAPIS: the exception of a late submission for one student,
// over the same port (migration 20261219290000). Same edge as the extensions: a
// malformed, refused or unknown id is the same 404 (C-23), a body the contract
// does not accept is 422, an answer outside the contract or a throw is 503.

type ExceptionList = { status: string; exceptions?: unknown };

function readLateRoute(
  id: string,
  load: (port: DeadlineExtensions, token: string, assignmentId: string) => Promise<ExceptionList>,
  port: DeadlineExtensions,
): Route {
  const { contract, body } = contractOf(id);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      try {
        const result = await load(port, token, assignmentId.toLowerCase());
        if (result.status !== "read") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = { exceptions: result.exceptions };
        if (Value.Check(body, answer)) return sendJson(response, 200, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

function grantLateRoute(port: DeadlineExtensions): Route {
  const { contract, body } = contractOf("teacher.late-exception.post");
  const input = contract.request.body!;
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
      const sent = json.value as { studentId: string; untilAt: string; reasonId: string };
      try {
        const result = await port.grantLateException(token, {
          assignmentId: assignmentId.toLowerCase(),
          studentId: sent.studentId.toLowerCase(),
          untilAt: sent.untilAt,
          reasonId: sent.reasonId,
        });
        if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "granted") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = { exception: result.exception };
        if (Value.Check(body, answer)) return sendJson(response, 201, answer);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          contract.id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The routes over one port: the extensions (list, record), then the late-submission exceptions (teacher list, record, student's own). */
export function createDeadlineExtensionRoutes(port: DeadlineExtensions): Route[] {
  return [
    listRoute(port),
    addRoute(port),
    readLateRoute("teacher.late-exceptions.get", (p, t, a) => p.listLateExceptions(t, a), port),
    grantLateRoute(port),
    readLateRoute("student.late-exceptions.get", (p, t, a) => p.listOwnLateExceptions(t, a), port),
  ];
}

/** The routes over main's application withActor. */
export function createDeadlineExtensionRoutesFor(main: { withActor: WithActor }): Route[] {
  return createDeadlineExtensionRoutes(createDeadlineExtensions(main.withActor));
}
