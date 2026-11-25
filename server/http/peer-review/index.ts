// SRV-V19-RECENZIJA-RUTE (Ductus#2055; val 19): the nine routes of the
// anonymous peer review (server/contracts/routes/peer-review.ts,
// docs/contracts/peer-review-v1.md). The handler checks the shape; the database
// decides who may do what from the relation (student enrolled, teacher of the
// course) and answers another's, an unknown and a malformed assignment, task or
// review with the same 404 (C-23). What a student reads is anonymous by its
// shape (server/domain/peer-review); the text of a review is never logged and no
// teacher route carries it. Nothing here grades, ranks or sanctions.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createPeerReviewStore, type WithActor } from "../../database/index.ts";
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

const route = (id: string) => ROUTES.find((candidate) => candidate.id === id)!;
const roundPut = route("peer-review.round.put");
const roundGet = route("peer-review.round.get");
const allocatePost = route("peer-review.allocate.post");
const overviewGet = route("peer-review.teacher-overview.get");
const withdrawalPost = route("peer-review.review-withdrawal.post");
const tasksGet = route("student.peer-review-tasks.get");
const workGet = route("student.peer-review-work.get");
const reviewPost = route("student.peer-review.post");
const receivedGet = route("student.peer-reviews-received.get");
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

type Json = Record<string, unknown>;
type Contract = (typeof ROUTES)[number];

function fieldOf(error: unknown, field: "code" | "message"): string | undefined {
  if (error && typeof error === "object" && field in error) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The problem a refusal of the database becomes, or undefined for a failure
 * (503). A ZD409 names its reason in the message; a reason the route does not
 * declare is a failure, not a conflict under another name.
 */
function refusalOf(contract: Contract, error: unknown): readonly [number, string] | undefined {
  switch (fieldOf(error, "code")) {
    case "ZD401":
      return [401, "unauthorized"];
    case "ZD404":
      return [404, "not_found"];
    case "ZD422":
      return [422, "invalid_input"];
    case "ZD409": {
      const reason = fieldOf(error, "message");
      const declared = contract.errors.some((spec) => spec.status === 409 && spec.code === reason);
      return declared && reason !== undefined ? [409, reason] : undefined;
    }
    default:
      return undefined;
  }
}

export function createPeerReviewRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createPeerReviewStore(withActor);
  const contracts = [
    roundPut,
    roundGet,
    allocatePost,
    overviewGet,
    withdrawalPost,
    tasksGet,
    workGet,
    reviewPost,
    receivedGet,
  ] as const;
  return contracts.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");

      // A path id that is not a UUID is the same 404 as another's or an unknown one.
      const ids: Record<string, string> = {};
      for (const name of ["assignmentId", "taskId", "reviewId"] as const) {
        const value = params?.[name];
        if (value === undefined) continue;
        if (!UUID.test(value)) return refuse(response, 404, "not_found");
        ids[name] = value.toLowerCase();
      }
      if (contract.request.params !== undefined && !Value.Check(contract.request.params, ids)) {
        return refuse(response, 404, "not_found");
      }
      const assignmentId = ids.assignmentId ?? "";
      const taskId = ids.taskId ?? "";
      const reviewId = ids.reviewId ?? "";

      let body: Json = {};
      if (contract.request.body !== undefined) {
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
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
        if (!Value.Check(contract.request.body, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        body = json.value as Json;
      }

      try {
        let result: unknown;
        if (contract === roundPut) {
          result = await store.setRound(token, assignmentId, body as never);
        } else if (contract === roundGet) {
          result = await store.round(token, assignmentId);
        } else if (contract === allocatePost) {
          result = await store.allocate(token, assignmentId);
        } else if (contract === overviewGet) {
          result = await store.overview(token, assignmentId);
        } else if (contract === withdrawalPost) {
          result = await store.withdraw(token, assignmentId, reviewId, String(body.reason));
        } else if (contract === tasksGet) {
          result = await store.tasks(token, assignmentId);
        } else if (contract === workGet) {
          result = await store.work(token, taskId);
        } else if (contract === reviewPost) {
          result = await store.addReview(token, taskId, body as never);
        } else {
          result = await store.received(token, assignmentId);
        }
        const success = contract.responses[0]!;
        if (!Value.Check(success.body!, result)) throw new Error("invalid peer review result");
        sendJson(response, success.status, result);
      } catch (error) {
        const refusal = refusalOf(contract, error);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        // The error class only: never the message, so no text of a review reaches a log.
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (contract.method !== "GET") void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
