// SRV-1903 (P-D3): withdrawal of a submission and the history of submissions
// and withdrawals, over the port in server/database/submission-withdrawal
// (migration 20261201100100). The HTTP edge only; the rules are the
// database's, the receipt is signed in withdrawal-receipt.ts. The origin layer
// checks a POST before it gets here. A malformed, refused or unknown id is the
// same 404 (C-23); an answer outside the contract, or a throw, is 503 and the
// throw is reported, never a partial answer.
//
//   POST student/assignments/{a}/submission/withdrawal   the student withdraws
//   GET  student/assignments/{a}/submission/history      the student's history
//   GET  teacher/assignments/{a}/students/{s}/submission-history
//   GET, POST teacher/assignments/{a}/submission-withdrawal   the switch
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createSubmissionWithdrawals,
  type SubmissionHistoryEvent,
  type SubmissionWithdrawals,
  type WithActor,
} from "../../database/index.ts";
import type { SigningKeyProvider } from "../../external/keys/index.ts";
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

import { signedWithdrawalReceipt, withdrawSubmission } from "./withdrawal-receipt.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const body = contract?.responses.find((r) => r.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract, body };
}

/** A lowercase id of a path segment, or null: anything else is the same 404 as another's. */
const idOf = (segment: string | undefined) =>
  segment !== undefined && UUID.test(segment) ? segment.toLowerCase() : null;

/** A GET is same-origin or carries no Sec-Fetch-Site; the session's token, or the answer sent. */
function readerToken(request: IncomingMessage, response: ServerResponse): string | null {
  const site = request.headersDistinct["sec-fetch-site"];
  if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
    sendProblem(response, 403, "forbidden");
    return null;
  }
  const token = liveSessionTokenFromCookie(request.headers.cookie);
  if (token === undefined) {
    sendProblem(response, 401, "unauthorized");
    return null;
  }
  return token;
}

/** The answer if it is the contract's, else the 503 of an answer outside it. */
function sendChecked(
  response: ServerResponse,
  contract: { id: string },
  body: Parameters<typeof Value.Check>[0],
  answer: unknown,
): void {
  if (Value.Check(body, answer)) return sendJson(response, 200, answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  sendProblem(response, 503, "unavailable");
}

/** One event on the wire; its receipt parsed from the database's text, checked by the contract after. */
function wireEvent(event: SubmissionHistoryEvent): unknown {
  const base = {
    kind: event.kind,
    id: event.id,
    attempt: event.attempt,
    submissionId: event.submissionId,
    revision: event.revision,
    at: event.at,
  };
  if (event.kind === "withdrawal") {
    const receipt =
      event.signature === null
        ? null
        : signedWithdrawalReceipt(
            event.receiptPayload,
            event.payloadDigestSha256,
            event.signature,
            event.id,
          );
    if (event.signature !== null && receipt === null)
      throw new Error("malformed withdrawal receipt");
    return { ...base, receipt };
  }
  const receipt =
    event.signature === null || event.receiptPayload === null
      ? null
      : {
          payload: JSON.parse(event.receiptPayload) as unknown,
          payloadDigestSha256: event.payloadDigestSha256,
          signature: event.signature,
        };
  return { ...base, afterDeadline: event.afterDeadline, receipt };
}

function withdrawalRoute(port: SubmissionWithdrawals, signer: SigningKeyProvider): Route {
  const { contract, body } = contractOf("student.submission-withdrawal.post");
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const assignmentId = idOf(params?.assignmentId);
      if (assignmentId === null) return sendProblem(response, 404, "not_found");
      try {
        const result = await withdrawSubmission(port, signer, token, assignmentId);
        switch (result.status) {
          case "withdrawn":
            return sendChecked(response, contract, body, {
              status: "withdrawn",
              receipt: result.receipt,
            });
          case "unauthorized":
            return sendProblem(response, 401, "unauthorized");
          case "not_found":
            return sendProblem(response, 404, "not_found");
          case "disabled":
            return sendProblem(response, 409, "not_allowed");
          case "after_deadline":
            return sendProblem(response, 409, "refused");
          case "none":
            return sendProblem(response, 409, "not_started");
          case "pending":
            return sendProblem(response, 409, "conflict");
          case "unavailable":
            reportServerError(
              "route",
              new Error(`withdrawal unavailable: ${result.code}`),
              requestIdOf(response),
              contract.id,
            );
            return sendProblem(response, 503, "unavailable");
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

function studentHistoryRoute(port: SubmissionWithdrawals): Route {
  const { contract, body } = contractOf("student.submission-history.get");
  return {
    contract,
    async handle(request, response, params) {
      const token = readerToken(request, response);
      if (token === null) return;
      const assignmentId = idOf(params?.assignmentId);
      if (assignmentId === null) return sendProblem(response, 404, "not_found");
      try {
        const result = await port.studentHistory(token, assignmentId);
        if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.status !== "read") return sendProblem(response, 404, "not_found");
        return sendChecked(response, contract, body, {
          withdrawalAllowed: result.withdrawalAllowed,
          dueAt: result.dueAt,
          events: result.events.map(wireEvent),
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

function teacherHistoryRoute(port: SubmissionWithdrawals): Route {
  const { contract, body } = contractOf("teacher.submission-history.get");
  return {
    contract,
    async handle(request, response, params) {
      const token = readerToken(request, response);
      if (token === null) return;
      const assignmentId = idOf(params?.assignmentId);
      const studentId = idOf(params?.studentId);
      if (assignmentId === null || studentId === null)
        return sendProblem(response, 404, "not_found");
      try {
        const result = await port.teacherHistory(token, assignmentId, studentId);
        if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.status !== "read") return sendProblem(response, 404, "not_found");
        return sendChecked(response, contract, body, { events: result.events.map(wireEvent) });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

function settingGetRoute(port: SubmissionWithdrawals): Route {
  const { contract, body } = contractOf("teacher.submission-withdrawal.get");
  return {
    contract,
    async handle(request, response, params) {
      const token = readerToken(request, response);
      if (token === null) return;
      const assignmentId = idOf(params?.assignmentId);
      if (assignmentId === null) return sendProblem(response, 404, "not_found");
      try {
        const result = await port.setting(token, assignmentId);
        if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.status !== "read") return sendProblem(response, 404, "not_found");
        return sendChecked(response, contract, body, {
          allowed: result.allowed,
          changedAt: result.changedAt,
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

function settingPostRoute(port: SubmissionWithdrawals): Route {
  const { contract, body } = contractOf("teacher.submission-withdrawal.post");
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
      const assignmentId = idOf(params?.assignmentId);
      if (assignmentId === null) return sendProblem(response, 404, "not_found");
      const { allowed } = json.value as { allowed: boolean };
      try {
        const result = await port.setSetting(token, assignmentId, allowed);
        if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "read") return sendProblem(response, 404, "not_found");
        return sendChecked(response, contract, body, {
          allowed: result.allowed,
          changedAt: result.changedAt,
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The five routes over one port and the process's signer. */
export function createSubmissionWithdrawalRoutes(
  port: SubmissionWithdrawals,
  signer: SigningKeyProvider,
): Route[] {
  return [
    withdrawalRoute(port, signer),
    studentHistoryRoute(port),
    teacherHistoryRoute(port),
    settingGetRoute(port),
    settingPostRoute(port),
  ];
}

/** The routes over main's application withActor and the signer the submission uses. */
export function createSubmissionWithdrawalRoutesFor(
  main: { withActor: WithActor },
  deps: { readonly signer: SigningKeyProvider },
): Route[] {
  return createSubmissionWithdrawalRoutes(createSubmissionWithdrawals(main.withActor), deps.signer);
}
