import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import { parseInstant, readerOf, type Account, type State } from "./state.ts";

type Slot = Operations["work.consultation-slots.post"]["success"]["body"];
type Entry = State["consultationSlots"][number];

/** SRV-KONZ-STANJA: an open slot with its topic (null for none), as the server sends it. */
const withTopic = ({ slot, detail }: Entry): Slot => ({ ...slot, topic: detail?.topic ?? null });

export function workRole(state: State, documentId: string, account: Account | null) {
  return readerOf(
    state,
    state.works.find((work) => work.documentId === documentId),
    account,
  );
}

export function slotTime(value: string, now: Date): string | null {
  const time = parseInstant(value);
  const latest = new Date(now);
  latest.setUTCFullYear(now.getUTCFullYear() + 1);
  if (latest.getUTCMonth() !== now.getUTCMonth()) latest.setUTCDate(0);
  return time !== null && Date.parse(time) > now.getTime() && Date.parse(time) <= latest.getTime()
    ? time
    : null;
}

export const CONSULTATION_SLOT_HANDLERS: Handlers = {
  "work.consultation-slots.get": ({ state, account, params }) => {
    if (workRole(state, params.documentId, account) === null) return { error: "forbidden" };
    // SRV-MENTOR-1: a closed slot is left out, as institution.consultation_slots does.
    const slots = state.consultationSlots
      .filter(({ documentId, closed }) => documentId === params.documentId && closed === undefined)
      .map(withTopic)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    return { status: 200, body: { slots } };
  },
  "work.consultation-slots.post": ({ state, account, params, body, now }) => {
    if (workRole(state, params.documentId, account) !== "owner") return { error: "forbidden" };
    const startsAt = slotTime(body.startsAt, now);
    const pending = state.consultationSlots.filter(
      ({ documentId, slot, closed }) =>
        documentId === params.documentId && closed === undefined && slot.state !== "confirmed",
    ).length;
    if (startsAt === null || pending >= 20) return { error: "invalid_input" };
    const sequence = String(state.consultationSlots.length + 1).padStart(12, "0");
    const entry: Entry = {
      documentId: params.documentId,
      slot: {
        id: `c0200000-0000-4000-8000-${sequence}`,
        startsAt,
        proposedAt: now.toISOString(),
        state: "requested",
      },
      detail: { topic: body.topic ?? null, preparation: null },
    };
    state.consultationSlots.push(entry);
    return { status: 201, body: withTopic(entry) };
  },
  "work.consultation-slots.patch": ({ state, account, params, body, now }) => {
    const entry = state.consultationSlots.find(
      ({ documentId, slot }) => documentId === params.documentId && slot.id === params.slotId,
    );
    const needsRole = body.action === "accept" ? "owner" : "teacher";
    if (entry === undefined || workRole(state, params.documentId, account) !== needsRole)
      return { error: "forbidden" };
    const needsState = body.action === "accept" ? "countered" : "requested";
    const startsAt = body.action === "counter" ? slotTime(body.startsAt, now) : entry.slot.startsAt;
    if (startsAt === null) return { error: "invalid_input" };
    if (entry.closed !== undefined || entry.slot.state !== needsState) return { error: "conflict" };
    entry.slot = {
      ...entry.slot,
      startsAt,
      state: body.action === "counter" ? "countered" : "confirmed",
    };
    return { status: 200, body: withTopic(entry) };
  },
};
