// SRV-1703 (M6.7, Ductus#2052; D-51, N-03, N-05): the HTTP edge of a teacher's
// delayed comments, the comment bank and the changes since the last review.
// The edge only, as work-messages.ts: a live session cookie (401), the ids of
// the path decoded once (one that is not an id is the same 404 as another's
// work, C-23), for a POST the media type, the bounded body and its shape,
// then server/database/comment-delay (and the saved templates of
// server/database/teacher-notes for the bank). The database decides who may;
// a refusal of the relation is 404, and a student or another teacher never
// learns that a draft, a bank entry or a review mark exists. A throw is 503
// and reported.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";

import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createCommentDelay,
  createReplaySource,
  createTeacherNotes,
  type CommentDelay,
  type CommentKind,
  type CommentDelayRefusal,
  type TeacherNotes,
  type WithActor,
} from "../../database/index.ts";
import { compareWorkVersions } from "../../evidence/index.ts";
import {
  createEditStepsV1Replayer,
  createEditStepsV3Replayer,
  type InstitutionEvidencePayloadReader,
} from "../../external/storage/index.ts";
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

const find = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const DRAFTS_GET = find("work.comment-drafts.get");
const DRAFTS_POST = find("work.comment-drafts.post");
const DRAFTS_SECOND_POST = find("work.comment-drafts-second.post");
const DRAFT_DELETE = find("work.comment-draft.delete");
const PUBLISH = find("work.comments.publish.post");
const PUBLISH_SELECTED = find("work.comments.publish-selected.post");
const BANK_GET = find("teacher.comment-bank.get");
const BANK_POST = find("teacher.comment-bank.post");
const BANK_PUT = find("teacher.comment-bank-entry.put");
const BANK_DELETE = find("teacher.comment-bank.delete");
const REVIEW = find("work.review.post");
const CHANGES = find("work.changes-since-review.get");

const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Status = CommentDelayRefusal["status"];

/** Answers a closed refusal of a port with its status and problem code. */
function refusalOf(response: ServerResponse, status: Status): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  if (status === "conflict") return sendProblem(response, 409, "conflict");
  return sendProblem(response, 503, "unavailable");
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

/** The id of a path segment, or null: anything else is the same 404 as another's. */
function idOf(segment: string | undefined): string | null {
  const id = workIdFromPath(segment ?? "");
  return id !== null && UUID.test(id) ? id : null;
}

/** NFC, no control character but newline and tab, no bidi control: the server's side of a comment text. */
const wellFormed = (text: string) =>
  text === text.normalize("NFC") &&
  !/\p{Cc}/u.test(text.replace(/[\n\t]/gu, "")) &&
  !BIDI.test(text);

/** The body of a POST: its media type, its size and its shape, or the answer sent. */
async function readJson<T>(
  request: IncomingMessage,
  response: ServerResponse,
  contract: { request: { maxBodyBytes?: number; body?: TSchema } },
): Promise<T | null> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return null;
  }
  const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return null;
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return null;
  }
  if (!Value.Check(contract.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return null;
  }
  return json.value as T;
}

/** readJson, and the text rule. */
async function readBody<T extends { text: string }>(
  request: IncomingMessage,
  response: ServerResponse,
  contract: { request: { maxBodyBytes?: number; body?: TSchema } },
): Promise<T | null> {
  const body = await readJson<T>(request, response, contract);
  if (body === null) return null;
  if (!wellFormed(body.text)) {
    sendProblem(response, 422, "invalid_input");
    return null;
  }
  return body;
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

/** A step that reads the session and the work id of a route, or answers and gives null. */
function sessionAndWork(
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string> | undefined,
  mutation: boolean,
): { token: string; documentId: string } | null {
  const token = liveSessionTokenFromCookie(request.headers.cookie);
  if (token === undefined) {
    if (mutation) refuse(response, 401, "unauthorized");
    else sendProblem(response, 401, "unauthorized");
    return null;
  }
  const documentId = workIdFromPath(params?.documentId ?? "");
  if (documentId === null || !isWorkId(documentId)) {
    if (mutation) refuse(response, 404, "not_found");
    else sendProblem(response, 404, "not_found");
    return null;
  }
  return { token, documentId };
}

export function createCommentDraftRoutes(delay: CommentDelay): Route[] {
  return [
    {
      contract: DRAFTS_GET,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, false);
        if (scope === null) return;
        try {
          const answer = await delay.listDrafts(scope.token, scope.documentId);
          if (answer.status === "ok") return sendJson(response, 200, { drafts: answer.drafts });
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, DRAFTS_GET.id, error);
        }
      },
    },
    {
      contract: DRAFTS_POST,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, true);
        if (scope === null) return;
        const body = await readBody<
          { text: string; anchor: Record<string, unknown> } | { text: string; threadId: string }
        >(request, response, DRAFTS_POST);
        if (body === null) return;
        try {
          if ("anchor" in body) {
            const answer = await delay.createDraft(
              scope.token,
              scope.documentId,
              body.text,
              body.anchor,
            );
            if (answer.status === "ok")
              return sendJson(response, 201, { threadId: answer.threadId });
            return refusalOf(response, answer.status);
          }
          const threadId = idOf(body.threadId);
          if (threadId === null) return sendProblem(response, 404, "not_found");
          const answer = await delay.replyDraft(scope.token, scope.documentId, threadId, body.text);
          if (answer.status === "ok")
            return sendJson(response, 201, { commentId: answer.commentId });
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, DRAFTS_POST.id, error);
        }
      },
    },
    {
      contract: DRAFTS_SECOND_POST,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, true);
        if (scope === null) return;
        const body = await readBody<{
          text: string;
          anchor: Record<string, unknown> | null;
          kind?: CommentKind | null;
        }>(request, response, DRAFTS_SECOND_POST);
        if (body === null) return;
        try {
          const answer = await delay.createDraftWithKind(
            scope.token,
            scope.documentId,
            body.text,
            body.anchor,
            body.kind ?? null,
          );
          if (answer.status === "ok") return sendJson(response, 201, { threadId: answer.threadId });
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, DRAFTS_SECOND_POST.id, error);
        }
      },
    },
    {
      contract: DRAFT_DELETE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const commentId = idOf(params?.commentId);
        if (commentId === null) return refuse(response, 404, "not_found");
        try {
          const answer = await delay.discardDraft(token, commentId);
          if (answer.status === "ok") return noContent(response);
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, DRAFT_DELETE.id, error);
        }
      },
    },
    {
      contract: PUBLISH,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, true);
        if (scope === null) return;
        try {
          const answer = await delay.publish(scope.token, scope.documentId);
          if (answer.status === "ok")
            return sendJson(response, 200, { published: answer.published });
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, PUBLISH.id, error);
        }
      },
    },
    {
      contract: PUBLISH_SELECTED,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, true);
        if (scope === null) return;
        const body = await readJson<{ draftIds: string[] }>(request, response, PUBLISH_SELECTED);
        if (body === null) return;
        try {
          const answer = await delay.publishListed(scope.token, scope.documentId, body.draftIds);
          if (answer.status === "ok")
            return sendJson(response, 200, { published: answer.published });
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, PUBLISH_SELECTED.id, error);
        }
      },
    },
  ];
}

type BankBody = {
  text: string;
  kind: "must" | "sugg" | "q" | "praise";
  label?: string | null;
};

/** readBody, and the label rule: NFC and no bidi control (the rest is the contract's). */
async function readBankBody(
  request: IncomingMessage,
  response: ServerResponse,
  contract: { request: { maxBodyBytes?: number; body?: TSchema } },
): Promise<BankBody | null> {
  const body = await readBody<BankBody>(request, response, contract);
  if (body === null) return null;
  const label = body.label;
  if (
    label !== undefined &&
    label !== null &&
    (label !== label.normalize("NFC") || BIDI.test(label))
  ) {
    sendProblem(response, 422, "invalid_input");
    return null;
  }
  return body;
}

export function createCommentBankRoutes(notes: TeacherNotes): Route[] {
  return [
    {
      contract: BANK_GET,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        try {
          const answer = await notes.listTemplates(token);
          if (answer.status !== "ok") return refusalOf(response, answer.status);
          return sendJson(response, 200, {
            entries: answer.items.map((entry) => ({
              id: entry.templateId,
              kind: entry.kind,
              text: entry.body,
              label: entry.label,
              createdAt: entry.createdAt,
            })),
          });
        } catch (error) {
          return unavailable(response, BANK_GET.id, error);
        }
      },
    },
    {
      contract: BANK_POST,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const body = await readBankBody(request, response, BANK_POST);
        if (body === null) return;
        try {
          const answer = await notes.createTemplate(
            token,
            body.text,
            body.kind,
            body.label ?? null,
          );
          if (answer.status === "created") {
            return sendJson(response, 201, { id: answer.id, createdAt: answer.createdAt });
          }
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, BANK_POST.id, error);
        }
      },
    },
    {
      contract: BANK_PUT,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const entryId = idOf(params?.entryId);
        // A path that is no id is the same 404 as another's entry or a missing one.
        if (entryId === null) return refuse(response, 404, "not_found");
        const body = await readBankBody(request, response, BANK_PUT);
        if (body === null) return;
        try {
          const answer = await notes.updateTemplate(
            token,
            entryId,
            body.text,
            body.kind,
            body.label ?? null,
          );
          if (answer.status === "updated") return noContent(response);
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, BANK_PUT.id, error);
        }
      },
    },
    {
      contract: BANK_DELETE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const entryId = idOf(params?.entryId);
        if (entryId === null) return refuse(response, 404, "not_found");
        try {
          const answer = await notes.deleteTemplate(token, entryId);
          if (answer.status === "deleted") return noContent(response);
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, BANK_DELETE.id, error);
        }
      },
    },
  ];
}

/** What the comparison needs besides the session: the storage of every institution. */
export type ChangesDeps = { readonly payloads: InstitutionEvidencePayloadReader };

export function createWorkReviewRoutes(
  delay: CommentDelay,
  compareFor: (token: string) => {
    compare(documentId: string, from: number, to: number): ReturnType<typeof compareWorkVersions>;
  },
): Route[] {
  return [
    {
      contract: REVIEW,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, true);
        if (scope === null) return;
        try {
          const answer = await delay.markReviewed(scope.token, scope.documentId);
          if (answer.status === "ok") {
            return sendJson(response, 200, {
              reviewedRevision: answer.reviewedRevision,
              reviewedAt: answer.reviewedAt,
            });
          }
          return refusalOf(response, answer.status);
        } catch (error) {
          return unavailable(response, REVIEW.id, error);
        }
      },
    },
    {
      contract: CHANGES,
      async handle(request, response, params) {
        const scope = sessionAndWork(request, response, params, false);
        if (scope === null) return;
        try {
          const state = await delay.reviewState(scope.token, scope.documentId);
          if (state.status !== "ok") return refusalOf(response, state.status);
          const { reviewedRevision, currentRevision } = state;
          // No baseline, or nothing since: the comparison is not asked (and no access log row).
          if (reviewedRevision === null || currentRevision <= reviewedRevision) {
            return sendJson(response, 200, {
              reviewedRevision,
              currentRevision,
              changed: false,
              blocks: [],
            });
          }
          const result = await compareFor(scope.token).compare(
            scope.documentId,
            reviewedRevision,
            currentRevision,
          );
          if (result.status === "ok") {
            return sendJson(response, 200, {
              reviewedRevision,
              currentRevision,
              changed: result.blocks.some((block) => block.change !== "unchanged"),
              blocks: result.blocks,
            });
          }
          if (result.status === "unauthenticated")
            return sendProblem(response, 401, "unauthorized");
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (result.status === "unavailable") {
            reportServerError(
              "route",
              new Error(`changes unavailable: ${result.reason}`),
              requestIdOf(response),
              CHANGES.id,
            );
          }
          return sendProblem(response, 503, "unavailable");
        } catch (error) {
          return unavailable(response, CHANGES.id, error);
        }
      },
    },
  ];
}

/** All routes over main's application withActor and the storage of every institution. */
export function createCommentRoutesFor(main: { withActor: WithActor }, deps: ChangesDeps): Route[] {
  const delay = createCommentDelay(main.withActor);
  return [
    ...createCommentDraftRoutes(delay),
    ...createCommentBankRoutes(createTeacherNotes(main.withActor)),
    ...createWorkReviewRoutes(delay, (token) => ({
      compare: (documentId, from, to) =>
        compareWorkVersions(
          {
            source: createReplaySource(main.withActor, token),
            payloads: deps.payloads,
            replayers: { v1: createEditStepsV1Replayer(), v3: createEditStepsV3Replayer() },
          },
          documentId,
          from,
          to,
        ),
    })),
  ];
}
