import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

export const MILESTONE_HANDLERS: Handlers = {
  "work.milestones.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    if (readerOf(state, work, account) === null) return { error: "not_found" };
    return { status: 200, body: { milestones: state.milestones.get(params.documentId) ?? [] } };
  },
  "work.milestones.patch": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    if (work.state === "submitted") return { error: "conflict" };
    const date = new Date(body.dueAt);
    const year = date.getUTCFullYear();
    const calendarDay = body.dueAt.slice(0, 10);
    const midnight = new Date(`${calendarDay}T00:00:00Z`);
    if (
      !(year >= 1 && year <= 9999) ||
      !Number.isFinite(midnight.getTime()) ||
      midnight.toISOString().slice(0, 10) !== calendarDay
    ) {
      return { error: "invalid_input" };
    }
    milestone.dueAt = date.toISOString();
    return { status: 200, body: milestone };
  },
};
