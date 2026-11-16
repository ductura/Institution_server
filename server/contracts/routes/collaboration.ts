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

export const collaborationRoutes = [commentsPost] as const;
