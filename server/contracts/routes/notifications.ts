import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";
import { MUTATION_GUARD } from "./shared.ts";

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
    Type.Literal("work_returned"),
  ]),
  targetId: NotificationId,
  createdAt: Instant,
  readAt: Type.Union([Instant, Type.Null()]),
});
export const NotificationsPage = closed({
  notifications: Type.Array(Notification, { maxItems: NOTIFICATIONS_PAGE_SIZE }),
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

export const notificationsRoutes = [notificationsGet, notificationReadPost] as const;
