// The amendments and disputes of process summary events on the dev fake
// server (work.event-disputes.get and .post, SRV-1315): the student who owns
// the work adds, the owner and the readers of the work (readerOf) read the same
// list, a reader who is not the owner is refused with 403 and anyone else with
// 404. Records are only added; the process summary is not touched. The real
// rules are app.add_work_event_dispute and app.work_event_disputes.
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

/** The nth id: 000000d0 for the records (the fake counts, so a scenario can name the first). */
const idOf = (n: number): string => `000000d0-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const EVENT_DISPUTE_HANDLERS: Handlers = {
  "work.event-disputes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const disputes = state.eventDisputes
      .filter((record) => record.documentId === work.documentId)
      .map(({ documentId: _work, ...record }) => record);
    return { status: 200, body: { disputes } };
  },
  "work.event-disputes.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "owner") return { error: "forbidden" };
    if (body.text.trim() === "") return { error: "invalid_input" };
    const record = {
      disputeId: idOf(state.eventDisputes.length + 1),
      kind: body.kind,
      eventId: body.eventId,
      text: body.text,
      createdAt: now.toISOString(),
    };
    state.eventDisputes.push({ documentId: work.documentId, ...record });
    return { status: 201, body: { disputeId: record.disputeId, createdAt: record.createdAt } };
  },
};
