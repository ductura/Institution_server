import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// Literal port of Ductus 078c780 app/api/comments/[action]/route.ts and
// src/server/collaboration/comments.ts (B-10). Reads are POST too, so a work
// id never lands in a URL. Identity, role, institution and author are never
// in the body: the RPCs take them from the session. No handler yet
// (CONTRACT_ONLY).

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
/** A thread or comment id (comments.ts UUID, any case). */
const Id = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character. */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/**
 * isCommentBody: 1 to 2000 code points with a non-space. NFC, no control
 * character but newline and tab and no bidi control stay the server's (422).
 */
const CommentBody = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}`,
});
const anchorText = (max: number) =>
  Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){0,${max}}${END}` });
const Hint = Type.Integer({ minimum: 0, maximum: 1_000_000 });

/** isTextAnchorInput: exactly six fields; startHint < endHint is the server's (422). */
const TextAnchor = closed({
  nodeId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  }),
  quote: Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,500}${END}` }),
  prefix: anchorText(64),
  suffix: anchorText(64),
  startHint: Hint,
  endHint: Hint,
});

/** One body per action; the action in the path picks which one the server reads. */
const COMMENT_BODIES = [
  closed({ anchor: TextAnchor, body: CommentBody, documentId: WorkId }),
  closed({ body: CommentBody, threadId: Id }),
  closed({ threadId: Id }),
  closed({ commentId: Id }),
  closed({ documentId: WorkId }),
] as const;

const Window = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** CommentView: a deleted comment has no text and a deletion window; a standing one the reverse. */
const commentView = (standing: boolean) =>
  closed({
    threadId: Id,
    commentId: Id,
    position: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    authorRole: literals(["teacher", "student"]),
    isOwn: Type.Boolean(),
    body: standing ? Type.String() : Type.Null(),
    anchor: Type.Union([Type.Object({}), Type.Null()]),
    state: literals(["open", "answered", "resolved"]),
    createdWindow: Window,
    deletedWindow: standing ? Type.Null() : Window,
  });

export const commentsPost = defineRoute({
  id: "collaboration.comments.post",
  method: "POST",
  path: "/api/v1/comments/{action}",
  inventory: "app/api/comments/[action]/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Comments on a work (B-10). The action picks the body: create {anchor, body, documentId} and reply {body, threadId} answer 200 {id}; resolve and reopen {threadId} and delete {commentId} answer 204; list {documentId} answers 200 {comments}. Exactly those keys, at most 16 KiB; an unknown action is 404. The database decides who may read or write (403); a thread that changed in the meantime is 409.",
  request: {
    params: closed({
      action: literals(["create", "reply", "resolve", "reopen", "delete", "list"]),
    }),
    contentType: "application/json",
    maxBodyBytes: 16 * 1024,
    body: Type.Union([...COMMENT_BODIES]),
  },
  responses: [
    {
      status: 200,
      description: "the new comment's id (create, reply) or the comments (list)",
      body: Type.Union([
        closed({ id: Id }),
        closed({ comments: Type.Array(Type.Union([commentView(true), commentView(false)])) }),
      ]),
    },
    { status: 204, description: "resolved, reopened or deleted" },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

// Literal port of Ductus 078c780 app/api/revision-requests/[action]/route.ts,
// src/server/collaboration/revision-requests.ts and
// src/domain/collaboration/revision-input.ts (DAN-314 2f). Output uses the
// column names of the RPCs.

/** isRequestId: a lowercase UUID only. */
const RequestId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/**
 * isRevisionText: 1 to 2000 code points, no lone surrogate. NFC, a visible
 * character, no control character but newline and tab and no bidi control
 * stay the server's (422).
 */
const RevisionText = Type.String({
  pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}`,
});
const RevisionNumber = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ExpectedSeq = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RangeHash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const RevisionKind = literals(["done", "declined"]);
const RevisionState = literals(["open", "responded", "accepted", "reopened", "withdrawn"]);
const Version = Type.Integer({ minimum: 1, maximum: 1000 });
const Seq = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/** One body per action; the exact JCS bytes of it, as the server reads it. */
const REVISION_BODIES = [
  closed({
    anchor: TextAnchor,
    documentId: WorkId,
    instruction: RevisionText,
    requestedRevision: RevisionNumber,
  }),
  closed({
    expectedSeq: ExpectedSeq,
    explanation: RevisionText,
    kind: RevisionKind,
    requestId: RequestId,
    responseRevision: RevisionNumber,
  }),
  // The hash and the anchor it was computed under travel together (#1831 B).
  closed({
    acceptedAnchor: Type.Null(),
    acceptedRevision: RevisionNumber,
    expectedSeq: ExpectedSeq,
    rangeHash: Type.Null(),
    requestId: RequestId,
  }),
  closed({
    acceptedAnchor: TextAnchor,
    acceptedRevision: RevisionNumber,
    expectedSeq: ExpectedSeq,
    rangeHash: RangeHash,
    requestId: RequestId,
  }),
  closed({
    expectedSeq: ExpectedSeq,
    instruction: RevisionText,
    requestId: RequestId,
    requestedRevision: RevisionNumber,
  }),
  closed({ expectedSeq: ExpectedSeq, requestId: RequestId }),
  closed({ documentId: WorkId }),
] as const;

const current = { row_seq: Seq, version: Version, state: RevisionState };

/** A response and a closing are each whole or absent; accepted_revision only with "accepted". */
const RESPONSE = [
  {
    response_kind: RevisionKind,
    response_explanation: Type.String(),
    response_revision: RevisionNumber,
    response_is_own: Type.Boolean(),
    response_window: Window,
  },
  {
    response_kind: Type.Null(),
    response_explanation: Type.Null(),
    response_revision: Type.Null(),
    response_is_own: Type.Null(),
    response_window: Type.Null(),
  },
] as const;
const CLOSING = [
  {
    closed_as: Type.Literal("accepted"),
    closed_is_own: Type.Boolean(),
    closed_window: Window,
    accepted_revision: RevisionNumber,
    accepted_range_hash: Type.Union([RangeHash, Type.Null()]),
  },
  {
    closed_as: literals(["reopened", "withdrawn"]),
    closed_is_own: Type.Boolean(),
    closed_window: Window,
    accepted_revision: Type.Null(),
    accepted_range_hash: Type.Null(),
  },
  {
    closed_as: Type.Null(),
    closed_is_own: Type.Null(),
    closed_window: Type.Null(),
    accepted_revision: Type.Null(),
    accepted_range_hash: Type.Null(),
  },
] as const;
const ListRow = Type.Union(
  RESPONSE.flatMap((response) =>
    CLOSING.map((closing) =>
      closed({
        request_id: RequestId,
        request_state: RevisionState,
        request_version: Version,
        request_row_seq: Seq,
        anchor: Type.Union([Type.Object({}), Type.Null()]),
        version: Version,
        instruction: Type.String(),
        requested_revision: RevisionNumber,
        opened_is_own: Type.Boolean(),
        opened_window: Window,
        ...response,
        ...closing,
      }),
    ),
  ),
);

export const revisionRequestsPost = defineRoute({
  id: "collaboration.revision-requests.post",
  method: "POST",
  path: "/api/v1/revision-requests/{action}",
  inventory: "app/api/revision-requests/[action]/route.ts",
  access: "owner_or_course_teacher",
  summary:
    'Revision requests on a work (DAN-314). The action picks the body, as its exact JCS bytes, at most 16 KiB: create {anchor, documentId, instruction, requestedRevision} answers 200 {request_id, row_seq, version, state}; respond, accept, reopen, rereview and withdraw (with requestId and expectedSeq) answer 200 {outcome: "applied", row_seq, version, state}, or 409 {outcome: "conflict", row_seq, version, state} when expectedSeq is stale; list {documentId} answers 200 {requests}. A malformed id reads as a foreign one (403); a transition the state does not allow is 409 not_allowed; an unknown action is 404.',
  request: {
    params: closed({
      action: literals(["create", "respond", "accept", "reopen", "rereview", "withdraw", "list"]),
    }),
    contentType: "application/json",
    maxBodyBytes: 16 * 1024,
    body: Type.Union([...REVISION_BODIES]),
  },
  responses: [
    {
      status: 200,
      description: "created, applied, or the requests (list)",
      body: Type.Union([
        closed({ request_id: RequestId, ...current }),
        closed({ outcome: Type.Literal("applied"), ...current }),
        closed({ requests: Type.Array(ListRow) }),
      ]),
    },
    {
      status: 409,
      description: "expectedSeq is stale: the current counter, version and state",
      body: closed({ outcome: Type.Literal("conflict"), ...current }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(409, "not_allowed"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const collaborationRoutes = [commentsPost, revisionRequestsPost] as const;
