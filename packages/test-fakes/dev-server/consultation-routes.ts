// The consultation records of a work on the dev fake server
// (work.consultation-records.get and .post, work.consultation-additions.post,
// SRV-1105): the student of the work and the teachers of its course read the
// same list (readerOf) and add to the same record. A record names a revision
// of the same work (the fake keeps the current one, so 1 up to it); an empty
// topic or addition and a date that does not exist are refused. Records and
// additions are only added. The real rules are the functions of
// collaboration (list, create_consultation_record, add_consultation_addition).
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

/** The nth id of a kind: 000000c0 for records, 000000c1 for additions (the fake counts, so a scenario can name the first). */
const idOf = (kind: 0 | 1, n: number): string =>
  `000000c${kind}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** An instant on its whole minute (D-24). */
const minuteOf = (date: Date): string =>
  new Date(date.getTime() - (date.getTime() % 60_000)).toISOString();

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const CONSULTATION_HANDLERS: Handlers = {
  "work.consultation-records.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const records = state.consultations
      .filter((record) => record.documentId === work.documentId)
      .sort((a, b) => a.heldOn.localeCompare(b.heldOn))
      .map(({ documentId: _work, ...record }) => record);
    return { status: 200, body: { records } };
  },
  "work.consultation-records.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    if (body.topic.trim() === "" || !isCalendarDate(body.heldOn) || body.revision > work.revision) {
      return { error: "invalid_input" };
    }
    const record = {
      id: idOf(0, state.consultations.length + 1),
      heldOn: body.heldOn,
      revision: body.revision,
      topic: body.topic,
      agreement: body.agreement,
      additions: [],
    };
    state.consultations.push({ documentId: work.documentId, ...record });
    return { status: 201, body: record };
  },
  "work.consultation-additions.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const record = state.consultations.find(
      (r) => r.id === params.recordId && r.documentId === work.documentId,
    );
    if (record === undefined) return { error: "not_found" };
    if (body.text.trim() === "") return { error: "invalid_input" };
    const addition = {
      id: idOf(1, state.consultations.reduce((sum, r) => sum + r.additions.length, 0) + 1),
      text: body.text,
      createdAt: minuteOf(now),
    };
    record.additions.push(addition);
    return { status: 201, body: addition };
  },
};
