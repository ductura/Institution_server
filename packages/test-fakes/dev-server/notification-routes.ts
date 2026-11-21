import type { Handlers } from "./server.ts";
import { IDS, type State } from "./state.ts";

export const DEMO_NOTIFICATION_ID = "00000000-0000-4000-8000-000000001701";
const readAt = new WeakMap<State, string>();

export const NOTIFICATION_HANDLERS: Handlers = {
  "notifications.list.get": ({ account, state, query }) => {
    if (account === null) return { error: "unauthorized" };
    const owns = account.id === IDS.student;
    if (
      query.before !== undefined &&
      (!owns || query.before.toLowerCase() !== DEMO_NOTIFICATION_ID)
    )
      return { error: "not_found" };
    const notification = {
      id: DEMO_NOTIFICATION_ID,
      kind: "deadline_reminder" as const,
      targetId: IDS.assignment,
      createdAt: "2026-11-21T08:00:00.000Z",
      readAt: readAt.get(state) ?? null,
    };
    return {
      status: 200,
      body: {
        notifications: owns && query.before === undefined ? [notification] : [],
        nextBefore: null,
      },
    };
  },
  "notifications.read.post": ({ account, params, state, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (account.id !== IDS.student || params.id.toLowerCase() !== DEMO_NOTIFICATION_ID)
      return { error: "not_found" };
    if (!readAt.has(state)) readAt.set(state, now.toISOString());
    return { status: 204 };
  },
};
