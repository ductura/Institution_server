import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1703 (M6.7, Ductus#2052; D-51, N-03, N-05, D-246): delayed publishing of
// a teacher's comments, the teacher's comment bank and the changes of a work
// since the teacher's last review. Ductus has no such routes; the shapes are
// the task's (see the pull request, "Pretpostavke"). Identity, role and
// institution are never in a body: the RPCs take them from the session.
//
//   a draft         a comment only its author reads until published; the
//                   student never gets it from any route (pgTAP 201)
//   the bank        the teacher's saved comment templates (SRV-8B), private to
//                   their author; the student has no route to them
//   the review mark the revision of a work the teacher last reviewed, the
//                   teacher's own record; changes-since-review compares it
//                   with the current revision through the comparison of SRV-9E

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Id = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
/**
 * A comment: 1 to 2000 code points with a non-space (as a comment). NFC, no
 * control character but newline and tab and no bidi control stay the server's (422).
 */
const CommentText = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}`,
});
const anchorText = (max: number) =>
  Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){0,${max}}${END}` });
const Hint = Type.Integer({ minimum: 0, maximum: 1_000_000 });
/** isTextAnchorInput as collaboration.comments.post: exactly six fields; startHint < endHint is the server's (422). */
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
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const Draft = closed({
  threadId: Id,
  commentId: Id,
  /** 1 opens a thread, more is a reply. */
  position: Type.Integer({ minimum: 1, maximum: 10_000 }),
  text: Type.String(),
  /** The anchor of the thread as stored; null for a general comment. */
  anchor: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  state: literals(["open", "answered", "resolved"]),
  /** The 5-minute window of writing (P-03), never the exact instant. */
  createdWindow: Instant,
});

export const workCommentDraftsGet = defineRoute({
  id: "work.comment-drafts.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/comment-drafts",
  inventory: "app/api/works/[documentId]/comment-drafts/route.ts",
  access: "course_teacher",
  summary:
    "The caller's own unpublished comments on a work (D-51), in the order of their threads, at most 1000. Only a teacher of the work has any; the student and everyone else get the same 404 as for a work that is not there (C-23). A draft is read by no one but its author until it is published.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the caller's drafts, possibly none",
      body: closed({ drafts: Type.Array(Draft, { maxItems: 1000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const workCommentDraftsPost = defineRoute({
  id: "work.comment-drafts.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/comment-drafts",
  inventory: "app/api/works/[documentId]/comment-drafts/route.ts",
  access: "course_teacher",
  summary:
    "Writes a draft the student does not see until the teacher publishes (D-51): {text, anchor} opens a draft thread on a paragraph (201 {threadId}), {threadId, text} drafts a reply to a thread of the work (201 {commentId}); a reply to a resolved thread is 409. The text is 1 to 2000 characters with a non-space, NFC, no control character but newline and tab, no bidi control; at most 8 KiB, sent as application/json. At most 500 drafts of one teacher on one work (422). Only a teacher of the work may; every other caller gets 404.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: Type.Union([
      closed({ text: CommentText, anchor: TextAnchor }),
      closed({ threadId: Id, text: CommentText }),
    ]),
  },
  responses: [
    {
      status: 201,
      description: "the new draft: its thread for a new one, its comment for a reply",
      body: Type.Union([closed({ threadId: Id }), closed({ commentId: Id })]),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const workCommentDraftDelete = defineRoute({
  id: "work.comment-draft.delete",
  method: "DELETE",
  path: "/api/v1/comment-drafts/{commentId}",
  inventory: "app/api/comment-drafts/[commentId]/route.ts",
  access: "course_teacher",
  summary:
    "Removes a draft of the caller. A thread left with no published comment goes with its last draft. A published comment, another's draft and one that is not there all answer 404.",
  request: { params: closed({ commentId: Id }) },
  responses: [{ status: 204, description: "removed" }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const workCommentsPublishPost = defineRoute({
  id: "work.comments.publish.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/comments/publish",
  inventory: "app/api/works/[documentId]/comments/publish/route.ts",
  access: "course_teacher",
  summary:
    "Gives every draft of the caller on the work to the student at one instant (D-51) and answers how many. A teacher's published reply makes an answered thread open. No draft is 409. Only a teacher of the work may; every other caller gets 404. No body.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the number of comments published",
      body: closed({ published: Type.Integer({ minimum: 1, maximum: 100_000 }) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

/** At most 500 drafts of one teacher on one work, so at most 500 ids. */
export const workCommentsPublishSelectedPost = defineRoute({
  id: "work.comments.publish-selected.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/comments/publish-selected",
  inventory: "app/api/works/[documentId]/comments/publish-selected/route.ts",
  access: "course_teacher",
  summary:
    "Publishes the caller's drafts on the work as work.comments.publish.post does, but only when {draftIds} names exactly the comment ids of those drafts (the ones the teacher saw); any difference, or no draft, is 409 and nothing is published. Sent as application/json, at most 32 KiB. Only a teacher of the work may; every other caller gets 404.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 32 * 1024,
    // A repeated id is the port's 409: TypeBox checks uniqueItems with a hash the
    // generated validator does not carry.
    body: closed({ draftIds: Type.Array(Id, { minItems: 1, maxItems: 500 }) }),
  },
  responses: [
    {
      status: 200,
      description: "the number of comments published",
      body: closed({ published: Type.Integer({ minimum: 1, maximum: 100_000 }) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

const TEMPLATE_KIND = literals(["must", "sugg", "q", "praise"]);
/**
 * SRV-V17-BANK-EDIT: a short label of the teacher's on an entry, 1 to 40 code
 * points with a non-space and no control character (null = none). NFC and
 * the like stay as for a comment.
 */
const Label = Type.String({
  description: "A short label of the teacher's, 1 to 40 characters, NFC; null or missing is none.",
  pattern: `^(?=[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,40}${END}`,
});
const BankEntry = closed({
  id: Id,
  kind: TEMPLATE_KIND,
  text: Type.String(),
  // Optional in the schema so that adding it does not break a client (scripts/check-breaking.ts); the server always sends it.
  label: Type.Optional(Type.Union([Label, Type.Null()])),
  createdAt: Instant,
});

export const teacherCommentBankGet = defineRoute({
  id: "teacher.comment-bank.get",
  method: "GET",
  path: "/api/v1/teacher/comment-bank",
  inventory: "app/api/teacher/comment-bank/route.ts",
  access: "teacher",
  summary:
    "The caller's own comment bank (N-03): saved comments, oldest first, at most 200. It belongs to its author alone (D-130); no one else, a student included, reads or lists it, and it is not part of any view of a work.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the caller's bank, possibly empty",
      body: closed({ entries: Type.Array(BankEntry, { maxItems: 200 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const teacherCommentBankPost = defineRoute({
  id: "teacher.comment-bank.post",
  method: "POST",
  path: "/api/v1/teacher/comment-bank",
  inventory: "app/api/teacher/comment-bank/route.ts",
  access: "teacher",
  summary:
    "Saves a comment in the caller's bank: {text, kind}, kind one of must, sugg, q, praise; the text is as a comment's; at most 4 KiB, sent as application/json. At most 200 entries (422). Only a teacher whose role is confirmed may; every other caller gets 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: closed({
      text: CommentText,
      kind: TEMPLATE_KIND,
      label: Type.Optional(Type.Union([Label, Type.Null()])),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the saved entry",
      body: closed({ id: Id, createdAt: Instant }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const teacherCommentBankPut = defineRoute({
  id: "teacher.comment-bank-entry.put",
  method: "PUT",
  path: "/api/v1/teacher/comment-bank/{entryId}",
  inventory: "app/api/teacher/comment-bank/[entryId]/route.ts",
  access: "teacher",
  summary:
    "Replaces text, kind and label of an entry of the caller's bank: {text, kind, label?} as when saving; a missing label or null leaves the entry without one. The creation time stays. Another teacher's entry and one that is not there answer 404 (an invalid body is refused first, as when saving); at most 4 KiB, sent as application/json.",
  request: {
    params: closed({ entryId: Id }),
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: closed({
      text: CommentText,
      kind: TEMPLATE_KIND,
      label: Type.Optional(Type.Union([Label, Type.Null()])),
    }),
  },
  responses: [{ status: 204, description: "replaced" }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const teacherCommentBankDelete = defineRoute({
  id: "teacher.comment-bank.delete",
  method: "DELETE",
  path: "/api/v1/teacher/comment-bank/{entryId}",
  inventory: "app/api/teacher/comment-bank/[entryId]/route.ts",
  access: "teacher",
  summary:
    "Removes an entry of the caller's bank. Another teacher's entry and one that is not there answer 404.",
  request: { params: closed({ entryId: Id }) },
  responses: [{ status: 204, description: "removed" }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const workReviewPost = defineRoute({
  id: "work.review.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/review",
  inventory: "app/api/works/[documentId]/review/route.ts",
  access: "course_teacher",
  summary:
    "Records the current revision of the work as the one the caller has just reviewed (N-05); a later review moves it on. The revision comes from the record, never from the body (there is none). The mark is the teacher's own and the student never reads it. A work with no revision yet is 409. Only a teacher of the work may; every other caller gets 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the revision now marked reviewed and when",
      body: closed({ reviewedRevision: Revision, reviewedAt: Instant }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

const ChangeBlock = Type.Union([
  closed({
    kind: literals(["paragraph", "bulletItem", "quote"]),
    text: Type.String(),
    change: literals(["unchanged", "removed", "added"]),
  }),
  closed({
    kind: Type.Literal("heading"),
    level: Type.Integer({ minimum: 1, maximum: 6 }),
    text: Type.String(),
    change: literals(["unchanged", "removed", "added"]),
  }),
]);

export const workChangesSinceReviewGet = defineRoute({
  id: "work.changes-since-review.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/changes-since-review",
  inventory: "app/api/works/[documentId]/changes-since-review/route.ts",
  access: "course_teacher",
  summary:
    "What the student changed since the caller's last review (N-05): the difference by blocks between the reviewed revision and the current one, from the version comparison of SRV-9E, every block once as unchanged, removed or added, in order, at most 5000 per version. reviewedRevision is null before the first review (no baseline: changed is false and blocks is empty); when nothing changed since, changed is false and blocks is empty. Read like a replay, so a teacher's read writes a row of the access log. Only a teacher of the work may; every other caller gets 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the changes since the last review",
      body: closed({
        reviewedRevision: Type.Union([Revision, Type.Null()]),
        currentRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        changed: Type.Boolean(),
        blocks: Type.Array(ChangeBlock, { maxItems: 10_000 }),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const commentsRoutes = [
  workCommentDraftsGet,
  workCommentDraftsPost,
  workCommentDraftDelete,
  workCommentsPublishPost,
  workCommentsPublishSelectedPost,
  teacherCommentBankGet,
  teacherCommentBankPost,
  teacherCommentBankPut,
  teacherCommentBankDelete,
  workReviewPost,
  workChangesSinceReviewGet,
] as const;
