// Live view, comments, revision requests and the process summary of the dev
// fake server. Who may read a work is its student and the teachers of its
// course (readerOf); a teacher's read of the live state, the summary or the
// replay lands in the access log the student sees.
import { createHash, randomUUID } from "node:crypto";

import { applySuggestion, type CanonicalDocument } from "../../../server/domain/index.ts";
import type { Operations } from "../../contracts/index.ts";
import type { Context, Handlers } from "./server.ts";
import {
  readerOf,
  recordOpening,
  type DevSuggestion,
  type AccessEntry,
  type Account,
  type RevisionRequest,
  type State,
} from "./state.ts";
import { processSummary } from "./work.ts";

type RevisionRow = Extract<
  Operations["collaboration.revision-requests.post"]["success"]["body"],
  { requests: unknown }
>["requests"][number];
type RevisionBody = Operations["collaboration.revision-requests.post"]["body"];
type CommentBody = Operations["collaboration.comments.post"]["body"];

/** The five-minute window of an instant, the only time a collaborator sees. */
const windowOf = (iso: string): string => {
  const time = Date.parse(iso);
  return new Date(time - (time % 300_000)).toISOString();
};

function logRead(
  state: State,
  documentId: string,
  readerId: string,
  now: Date,
  surface: AccessEntry["surface"],
) {
  recordOpening(state, { documentId, readerId, role: "teacher", surface }, now);
}

function readProcessSummary({
  state,
  account,
  body,
  now,
}: Pick<Context<"projection.process-summary.post">, "state" | "account" | "body" | "now">) {
  const work = state.works.find((item) => item.documentId === body.documentId);
  const reader = readerOf(state, work, account);
  if (work === undefined || reader === null || account === null) return null;
  if (reader === "teacher") logRead(state, work.documentId, account.id, now, "process_summary");
  return processSummary(work);
}

function revisionRow(r: RevisionRequest, me: string): RevisionRow {
  const response =
    r.response === null
      ? {
          response_kind: null,
          response_explanation: null,
          response_revision: null,
          response_is_own: null,
          response_window: null,
        }
      : {
          response_kind: r.response.kind,
          response_explanation: r.response.explanation,
          response_revision: r.response.revision,
          response_is_own: r.response.byId === me,
          response_window: windowOf(r.response.at),
        };
  const closing =
    r.closing === null
      ? {
          closed_as: null,
          closed_is_own: null,
          closed_window: null,
          accepted_revision: null,
          accepted_range_hash: null,
        }
      : r.closing.as === "accepted"
        ? {
            closed_as: "accepted" as const,
            closed_is_own: r.closing.byId === me,
            closed_window: windowOf(r.closing.at),
            accepted_revision: r.closing.acceptedRevision ?? 0,
            accepted_range_hash: r.closing.rangeHash,
          }
        : {
            closed_as: r.closing.as,
            closed_is_own: r.closing.byId === me,
            closed_window: windowOf(r.closing.at),
            accepted_revision: null,
            accepted_range_hash: null,
          };
  return {
    request_id: r.id,
    request_state: r.state,
    request_version: r.version,
    request_row_seq: r.seq,
    anchor: r.anchor,
    version: r.version,
    instruction: r.instruction,
    requested_revision: r.requestedRevision,
    opened_is_own: r.openerId === me,
    opened_window: windowOf(r.openedAt),
    ...response,
    ...closing,
  } as RevisionRow;
}

/**
 * The keys of the body each action reads. The validator accepts any body of
 * the union; the body must be the one of its action (else 422), as the
 * server reads the body by the action in the path.
 */
const COMMENT_KEYS = {
  create: ["anchor", "body", "documentId"],
  reply: ["body", "threadId"],
  resolve: ["threadId"],
  reopen: ["threadId"],
  delete: ["commentId"],
  list: ["documentId"],
} as const;
const REVISION_KEYS = {
  create: ["anchor", "documentId", "instruction", "requestedRevision"],
  respond: ["expectedSeq", "explanation", "kind", "requestId", "responseRevision"],
  accept: ["acceptedAnchor", "acceptedRevision", "expectedSeq", "rangeHash", "requestId"],
  rereview: ["expectedSeq", "instruction", "requestId", "requestedRevision"],
  reopen: ["expectedSeq", "requestId"],
  withdraw: ["expectedSeq", "requestId"],
  list: ["documentId"],
} as const;

const hasKeys = (body: object, keys: readonly string[]): boolean =>
  Object.keys(body).sort().join() === [...keys].sort().join();

/** Which state each action moves a request from, and who may do it. */
const TRANSITIONS = {
  respond: { from: ["open", "reopened"], by: "owner" },
  accept: { from: ["responded"], by: "teacher" },
  reopen: { from: ["responded"], by: "teacher" },
  rereview: { from: ["responded", "reopened"], by: "teacher" },
  withdraw: { from: ["open", "responded", "reopened"], by: "teacher" },
} as const;

export const COLLABORATION_HANDLERS: Handlers = {
  "live.document.get": ({ state, account, params, header, now }) => {
    const work = state.works.find((w) => w.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null || account === null) return { error: "not_found" };
    if (work.live === null) return { status: 204 };
    if (reader === "teacher") logRead(state, work.documentId, account.id, now, "live_view");
    const etag = `"${createHash("sha256").update(work.live.json).digest("hex")}"`;
    if (header("if-none-match") === etag) return { status: 304, headers: { etag } };
    const headers: Record<string, string> = { etag };
    if (work.state === "submitted") headers["ductus-live-state"] = "submitted";
    return { status: 200, headers, body: JSON.parse(work.live.json) as Record<string, unknown> };
  },
  "live.document.put": ({ state, account, params, body, header }) => {
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    if (work.studentId !== account?.id) return { error: "forbidden" };
    if (!Array.isArray(body.nodes)) return { error: "invalid_document" };
    const ifMatch = header("if-match");
    const ifNone = header("if-none-match");
    if ((ifMatch === undefined) === (ifNone === undefined))
      return { error: "precondition_required" };
    const current = work.live?.token ?? null;
    const stale = ifNone === "*" ? current !== null : ifMatch !== `"${current}"`;
    if (stale) return { status: 409, body: { outcome: "conflict", token: current } };
    const json = JSON.stringify(body);
    if (work.live !== null && work.live.json === json)
      return { status: 200, body: { outcome: "unchanged", token: work.live.token } };
    work.live = { json, token: randomUUID() };
    return { status: 200, body: { outcome: "accepted", token: work.live.token } };
  },
  "projection.process-summary.post": (request) => {
    const summary = readProcessSummary(request);
    return summary === null ? { error: "not_found" } : { status: 200, body: summary };
  },
  "projection.process-summary-details.post": (request) => {
    const summary = readProcessSummary(request);
    if (summary === null) return { error: "not_found" };
    const activeEditingMinutes = summary.sessions.items.reduce(
      (total, { from, to }) =>
        total + Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000)),
      0,
    );
    return { status: 200, body: { summary, activeEditingMinutes, keyEvents: [] } };
  },
  "collaboration.comments.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    // create also takes an optional revision (INT-15-SRV).
    const keys: readonly string[] = COMMENT_KEYS[params.action];
    if (
      !hasKeys(body, keys) &&
      !(params.action === "create" && hasKeys(body, [...keys, "revision"]))
    )
      return { error: "invalid_input" };
    const input = body as Partial<Record<string, unknown>> & CommentBody;
    const threadOf = (id: unknown) => state.comments.find((c) => c.threadId === id);
    const documentId =
      typeof input.documentId === "string"
        ? input.documentId
        : (threadOf(input.threadId) ?? state.comments.find((c) => c.id === input.commentId))
            ?.documentId;
    const work = state.works.find((w) => w.documentId === documentId);
    if (work === undefined) return { error: "not_found" };
    const reader = readerOf(state, work, account);
    if (reader === null) return { error: "forbidden" };
    const at = now.toISOString();
    switch (params.action) {
      case "create": {
        // As create_revision_comment: a teacher must name a revision, which must
        // exist and be readable (here: 1 to the work's current revision).
        const revision = typeof input.revision === "number" ? input.revision : null;
        if (
          (reader === "teacher" && revision === null) ||
          (revision !== null && (revision < 1 || revision > work.revision))
        )
          return { error: "invalid_input" };
        const threadId = randomUUID();
        const anchor = (input.anchor ?? null) as Record<string, unknown> | null;
        state.comments.push({
          id: randomUUID(),
          threadId,
          documentId: work.documentId,
          authorId: account.id,
          body: String(input.body),
          anchor,
          revision,
          at,
          deletedAt: null,
        });
        state.threads.set(threadId, "open");
        return { status: 200, body: { id: threadId } };
      }
      case "reply": {
        const first = threadOf(input.threadId);
        if (first === undefined || state.threads.get(first.threadId) === "resolved")
          return { error: "conflict" };
        const id = randomUUID();
        state.comments.push({
          id,
          threadId: first.threadId,
          documentId: work.documentId,
          authorId: account.id,
          body: String(input.body),
          anchor: null,
          revision: first.revision,
          at,
          deletedAt: null,
        });
        if (first.authorId !== account.id) state.threads.set(first.threadId, "answered");
        return { status: 200, body: { id } };
      }
      case "resolve":
      case "reopen": {
        const first = threadOf(input.threadId);
        if (first === undefined) return { error: "not_found" };
        state.threads.set(first.threadId, params.action === "resolve" ? "resolved" : "open");
        return { status: 204 };
      }
      case "delete": {
        const comment = state.comments.find((c) => c.id === input.commentId);
        if (comment === undefined || comment.authorId !== account.id) return { error: "forbidden" };
        comment.deletedAt ??= at;
        return { status: 204 };
      }
      case "list": {
        const own = state.comments.filter((c) => c.documentId === work.documentId);
        const comments = own.map((c) => {
          const base = {
            threadId: c.threadId,
            commentId: c.id,
            position: own.filter((o) => o.threadId === c.threadId).indexOf(c),
            authorRole: c.authorId === work.studentId ? ("student" as const) : ("teacher" as const),
            isOwn: c.authorId === account.id,
            anchor: c.anchor,
            state: state.threads.get(c.threadId) ?? "open",
            createdWindow: windowOf(c.at),
            revision: c.revision,
          };
          return c.deletedAt === null
            ? { ...base, body: c.body, deletedWindow: null }
            : { ...base, body: null, deletedWindow: windowOf(c.deletedAt) };
        });
        return { status: 200, body: { comments } };
      }
    }
  },
  "collaboration.revision-requests.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!hasKeys(body, REVISION_KEYS[params.action])) return { error: "invalid_input" };
    const input = body as Partial<Record<string, unknown>> & RevisionBody;
    const found = state.revisionRequests.find((r) => r.id === input.requestId);
    const documentId = typeof input.documentId === "string" ? input.documentId : found?.documentId;
    const work = state.works.find((w) => w.documentId === documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "forbidden" };
    const at = now.toISOString();
    if (params.action === "list") {
      const requests = state.revisionRequests
        .filter((r) => r.documentId === work.documentId)
        .map((r) => revisionRow(r, account.id));
      return { status: 200, body: { requests } };
    }
    if (params.action === "create") {
      if (reader !== "teacher") return { error: "forbidden" };
      const request: RevisionRequest = {
        id: randomUUID(),
        documentId: work.documentId,
        openerId: account.id,
        openedAt: at,
        anchor: (input.anchor ?? {}) as Record<string, unknown>,
        instruction: String(input.instruction),
        requestedRevision: Number(input.requestedRevision),
        state: "open",
        seq: 1,
        version: 1,
        response: null,
        closing: null,
      };
      state.revisionRequests.push(request);
      return {
        status: 200,
        body: { request_id: request.id, row_seq: 1, version: 1, state: "open" },
      };
    }
    if (found === undefined) return { error: "forbidden" };
    const transition = TRANSITIONS[params.action];
    if (transition.by !== reader) return { error: "forbidden" };
    if (input.expectedSeq !== found.seq)
      return {
        status: 409,
        body: {
          outcome: "conflict",
          row_seq: found.seq,
          version: found.version,
          state: found.state,
        },
      };
    if (!(transition.from as readonly string[]).includes(found.state))
      return { error: "not_allowed" };
    if (params.action === "respond") {
      found.response = {
        kind: input.kind === "declined" ? "declined" : "done",
        explanation: String(input.explanation),
        revision: Number(input.responseRevision),
        byId: account.id,
        at,
      };
      found.closing = null;
      found.state = "responded";
    } else if (params.action === "rereview") {
      found.instruction = String(input.instruction);
      found.requestedRevision = Number(input.requestedRevision);
      found.version = Math.min(found.version + 1, 1000);
      found.response = null;
      found.closing = null;
      found.state = "open";
    } else {
      const accepted = params.action === "accept";
      found.closing = {
        as: accepted ? "accepted" : params.action === "reopen" ? "reopened" : "withdrawn",
        byId: account.id,
        at,
        acceptedRevision: accepted ? Number(input.acceptedRevision) : null,
        rangeHash: accepted && typeof input.rangeHash === "string" ? input.rangeHash : null,
      };
      found.state = found.closing.as;
    }
    found.seq += 1;
    return {
      status: 200,
      body: { outcome: "applied", row_seq: found.seq, version: found.version, state: found.state },
    };
  },
  // SRV-ED43-DORADA-POSALJI: the next round only when a request was opened or
  // reopened since the previous one; the teacher 403, anybody else 404.
  "collaboration.revision-send.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === body.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "owner") return { error: "forbidden" };
    if (work.submittedAt !== null) return { error: "not_allowed" };
    const sends = state.revisionSends.filter((s) => s.documentId === work.documentId);
    const last = sends.at(-1);
    const open = state.revisionRequests.filter(
      (r) => r.documentId === work.documentId && (r.state === "open" || r.state === "reopened"),
    );
    const fresh = open.some(
      (r) => !(r.id in (last?.answered ?? {})) || r.seq > last!.answered[r.id]!,
    );
    if (!fresh || sends.length >= 1000) return { error: "not_allowed" };
    const round = sends.length + 1;
    state.revisionSends.push({
      documentId: work.documentId,
      round,
      message: body.message,
      answered: Object.fromEntries(open.map((r) => [r.id, r.seq])),
    });
    return { status: 200, body: { round } };
  },
  // SRV-ED42-PRIJEDLOZI: a teacher's text suggestions, as the RPCs of
  // 20261220190000: a teacher creates on the current live state, both sides
  // list, only the owner decides, once; anybody else 404.
  "collaboration.suggestions-list.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === body.documentId);
    if (readerOf(state, work, account) === null) return { error: "not_found" };
    const suggestions = state.suggestions
      .filter((g) => g.documentId === body.documentId)
      .map(({ authorId, documentId: _d, ...view }) => ({
        ...view,
        isOwn: authorId === account.id,
      }));
    return { status: 200, body: { suggestions } };
  },
  "collaboration.suggestions.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === body.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    if (work.submittedAt !== null || work.live === null) return { error: "conflict" };
    const { anchor, text } = body;
    if (text === anchor.quote || text.normalize("NFC") !== text) return { error: "invalid_input" };
    const node = liveNodes(work.live.json).find((n) => n.id === anchor.nodeId);
    const nodeText = node?.children.map((c) => c.text).join("") ?? "";
    const stands =
      node !== undefined &&
      nodeText.slice(anchor.startHint, anchor.endHint) === anchor.quote &&
      nodeText.slice(0, anchor.startHint).endsWith(anchor.prefix) &&
      nodeText.startsWith(anchor.suffix, anchor.endHint);
    const held = state.suggestions.filter((g) => g.documentId === work.documentId).length;
    if (!stands || held >= 500) return { error: "conflict" };
    const baseHash = createHash("sha256").update(work.live.json).digest("hex");
    const suggestionId = randomUUID();
    state.suggestions.push({
      suggestionId,
      documentId: work.documentId,
      authorId: account.id,
      anchor,
      text,
      baseHash,
      state: "pending",
      createdWindow: window(now),
      decidedWindow: null,
    });
    return { status: 200, body: { suggestionId, baseHash } };
  },
  "collaboration.suggestion-accept.post": ({ state, account, body, now }) => {
    const decided = decide(state, account, body.suggestionId);
    if (!decided.ok) return { error: decided.error };
    const { suggestion, work } = decided;
    if (work.live === null) return { error: "conflict" };
    const outcome = applySuggestion(JSON.parse(work.live.json) as CanonicalDocument, {
      ...suggestion,
      anchor: suggestion.anchor as Parameters<typeof applySuggestion>[1]["anchor"],
      state: "pending",
    });
    if (!outcome.ok) return { error: "conflict" };
    suggestion.state = "accepted";
    suggestion.decidedWindow = window(now);
    const baseHash = createHash("sha256").update(work.live.json).digest("hex");
    return {
      status: 200,
      body: {
        suggestionId: suggestion.suggestionId,
        state: "accepted",
        baseHash,
        text: outcome.text,
        change: outcome.change,
      },
    };
  },
  "collaboration.suggestion-reject.post": ({ state, account, body, now }) => {
    const decided = decide(state, account, body.suggestionId);
    if (!decided.ok) return { error: decided.error };
    decided.suggestion.state = "rejected";
    decided.suggestion.decidedWindow = window(now);
    return { status: 204 };
  },
};

/** The P-03 window of 5 minutes, as list_suggestions answers it. */
const window = (now: Date) => new Date(Math.floor(now.getTime() / 300_000) * 300_000).toISOString();

type LiveNode = { id: string; children: { text: string }[] };
function liveNodes(json: string): LiveNode[] {
  const nodes = (JSON.parse(json) as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? (nodes as LiveNode[]) : [];
}

/** The owner's pending suggestion, as decide_suggestion checks it. */
function decide(state: State, account: Account | null, suggestionId: string) {
  if (account === null) return { ok: false as const, error: "unauthorized" as const };
  const suggestion = state.suggestions.find((g) => g.suggestionId === suggestionId);
  const work = state.works.find((w) => w.documentId === suggestion?.documentId);
  const reader = readerOf(state, work, account);
  if (suggestion === undefined || work === undefined || reader === null) {
    return { ok: false as const, error: "not_found" as const };
  }
  if (reader !== "owner") return { ok: false as const, error: "forbidden" as const };
  if (suggestion.state !== "pending" || work.submittedAt !== null) {
    return { ok: false as const, error: "conflict" as const };
  }
  return { ok: true as const, suggestion: suggestion as DevSuggestion, work };
}
