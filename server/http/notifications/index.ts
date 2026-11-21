import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  NotificationId,
  NotificationsPage,
  NOTIFICATIONS_PAGE_SIZE,
  notificationsRoutes,
} from "../../contracts/index.ts";
import { createNotifications, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import {
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const [LIST, READ] = notificationsRoutes;
const MIN_REMINDER_SECONDS = 300;
const BODY_TIMEOUT_MS = 5_000;

function reminderSeconds(raw: string | undefined): number {
  const value = Number(raw);
  return /^\d{1,10}$/u.test(raw ?? "") && value >= MIN_REMINDER_SECONDS && value <= 2_147_483_647
    ? value
    : MIN_REMINDER_SECONDS;
}

function databaseFailure(response: ServerResponse, error: unknown, operation: string): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ZD401") return sendProblem(response, 401, "unauthorized");
  if (code === "ZD403") return sendProblem(response, 404, "not_found");
  reportServerError("route", error, requestIdOf(response), operation);
  sendProblem(response, 503, "unavailable");
}

export function createNotificationsRoutesFor(
  main: { withActor: WithActor },
  configuredCooldown?: string,
): Route[] {
  const notifications = createNotifications(main.withActor);
  const cooldown = reminderSeconds(configuredCooldown);
  return [
    {
      contract: LIST,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const query = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
        const before = query.get("before");
        if (
          query.size > Number(before !== null) ||
          (before !== null && !Value.Check(NotificationId, before))
        )
          return sendProblem(response, 422, "invalid_input");
        try {
          const rows = await notifications.list(token, before, cooldown);
          const page = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
          const nextBefore = rows.length > page.length ? page.at(-1)?.id : null;
          const body = { notifications: page, nextBefore };
          if (!Value.Check(NotificationsPage, body))
            throw new Error("inbox response outside its contract");
          return sendJson(response, 200, body);
        } catch (error) {
          return databaseFailure(response, error, LIST.id);
        }
      },
    },
    {
      contract: READ,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const id = params?.id;
        if (!Value.Check(NotificationId, id)) return refuse(response, 404, "not_found");
        const raw = await readBodyWithLimit(request, READ.request.maxBodyBytes!, BODY_TIMEOUT_MS);
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        try {
          if (!(await notifications.markRead(token, id)))
            return sendProblem(response, 404, "not_found");
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } catch (error) {
          return databaseFailure(response, error, READ.id);
        }
      },
    },
  ];
}
