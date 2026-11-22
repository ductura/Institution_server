import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

export const NOTIFICATIONS_PAGE_SIZE = 50;
export const NotificationId = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\\s\\S])",
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Notification = closed({
  id: NotificationId,
  kind: Type.Union([
    Type.Literal("assignment_version"),
    Type.Literal("course_handover"),
    Type.Literal("comment_posted"),
    Type.Literal("submission_recorded"),
    Type.Literal("deadline_reminder"),
  ]),
  targetId: NotificationId,
  createdAt: Instant,
  readAt: Type.Union([Instant, Type.Null()]),
});
export const NotificationsPage = closed({
  notifications: Type.Array(Notification, { maxItems: NOTIFICATIONS_PAGE_SIZE }),
  nextBefore: Type.Union([NotificationId, Type.Null()]),
});

// SRV-1607 (Ductus#2052): the student is told when the teacher returns the work for revision
// (SRV-1606). It is NOT a sixth kind of notifications.list.get: a wider enum in a response
// breaks clients (contracts:breaking). It is its own list (a new route, a new minor version);
// notifications.list.get leaves these notifications out, notifications.read.post marks them.
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const RevisionNotification = closed({
  id: NotificationId,
  /** The assignment of the returned work; it carries no access to it. */
  targetId: NotificationId,
  /** The returned work. */
  documentId: DocumentId,
  /** The teacher's comment. */
  comment: Type.String({ minLength: 1, maxLength: 2000 }),
  /** The new revision due date; a reminder, it never blocks writing or submitting. */
  revisionDueAt: Type.Union([Instant, Type.Null()]),
  createdAt: Instant,
  readAt: Type.Union([Instant, Type.Null()]),
});
export const RevisionNotificationsPage = closed({
  notifications: Type.Array(RevisionNotification, { maxItems: NOTIFICATIONS_PAGE_SIZE }),
  nextBefore: Type.Union([NotificationId, Type.Null()]),
});

const unauthorized = error(401, "unauthorized");
const notFound = error(404, "not_found");
const unavailable = error(503, "unavailable");

export const notificationsGet = defineRoute({
  id: "notifications.list.get",
  method: "GET",
  path: "/api/v1/notifications",
  inventory: "app/api/notifications/route.ts",
  access: "signed_in",
  summary:
    "The signed-in account's inbox, newest first. Start without a cursor; pass nextBefore as before to continue. The first page may materialize a deadline reminder for the caller. A target identifier carries no access to the target.",
  request: { query: closed({ before: Type.Optional(NotificationId) }) },
  responses: [
    {
      status: 200,
      description: "one inbox page",
      body: NotificationsPage,
      headers: ["cache-control"],
    },
  ],
  errors: [unauthorized, notFound, error(422, "invalid_input"), unavailable],
});

export const notificationReadPost = defineRoute({
  id: "notifications.read.post",
  method: "POST",
  path: "/api/v1/notifications/{id}/read",
  inventory: "app/api/notifications/[id]/read/route.ts",
  access: "signed_in",
  summary:
    "Marks the caller's own notification as read. A retry preserves the first read time. Unknown and inaccessible identifiers return the same 404.",
  request: { params: closed({ id: NotificationId }), maxBodyBytes: 0 },
  responses: [{ status: 204, description: "notification marked read" }],
  errors: [unauthorized, notFound, unavailable, ...MUTATION_GUARD],
});

export const notificationsRevisionsGet = defineRoute({
  id: "notifications.returned-for-revision.list.get",
  method: "GET",
  path: "/api/v1/notifications/returned-for-revision",
  inventory: "app/api/notifications/returned-for-revision/route.ts",
  access: "signed_in",
  summary:
    "The signed-in student's notifications that a teacher returned a work for revision, newest first, each with the work, the teacher's comment and the new revision due date. Only the student owner of the work sees one. Start without a cursor; pass nextBefore as before to continue. Mark one read with notifications.read.post.",
  request: { query: closed({ before: Type.Optional(NotificationId) }) },
  responses: [
    {
      status: 200,
      description: "one page of notifications",
      body: RevisionNotificationsPage,
      headers: ["cache-control"],
    },
  ],
  errors: [unauthorized, notFound, error(422, "invalid_input"), unavailable],
});

export const notificationsRoutes = [
  notificationsGet,
  notificationReadPost,
  notificationsRevisionsGet,
] as const;
