// The rhythm of typing on the dev fake server (PIL-P1-RITAM-SRV, P-1 rule 4):
// the student who owns the work records bursts of gaps in milliseconds and
// deletes them; the owner and the readers of the work (readerOf) read the
// bursts and the state of the switch; only the teacher of the assignment's
// course switches it. While it is off nothing is recorded and nothing is read.
// The real rule is app.input_rhythm_* (20261213100300, 20261213110100). The
// bursts and the switch live in memory beside the state.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { readerOf, teachesCourse, type Account, type State } from "./state.ts";

type Burst = { id: string; gapsMs: number[]; recordedAt: string; documentId: string };
const BURSTS = new WeakMap<object, Burst[]>();
const OFF = new WeakMap<object, Set<string>>();

const offOf = (state: State): Set<string> => {
  const set = OFF.get(state) ?? new Set<string>();
  OFF.set(state, set);
  return set;
};

function taught(state: State, account: Account | null, assignmentId: string): string | null {
  const assignment = state.assignments.find((a) => a.id === assignmentId);
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment.id
    : null;
}

function workOf(state: State, account: Account | null, documentId: string, ownerOnly: boolean) {
  const work = state.works.find((w) => w.documentId === documentId);
  const reader = work === undefined ? null : readerOf(state, work, account);
  if (work === undefined || reader === null || (ownerOnly && reader !== "owner")) return null;
  return work;
}

export const INPUT_RHYTHM_HANDLERS: Handlers = {
  "work.input-rhythm.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = workOf(state, account, params.documentId, true);
    if (work === null) return { error: "not_found" };
    if (offOf(state).has(work.assignmentId)) return { status: 200, body: { recorded: false } };
    const list = BURSTS.get(state) ?? [];
    BURSTS.set(state, list);
    list.push({
      id: randomUUID(),
      gapsMs: [...body.gapsMs],
      recordedAt: now.toISOString(),
      documentId: work.documentId,
    });
    return { status: 200, body: { recorded: true } };
  },
  "work.input-rhythm.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = workOf(state, account, params.documentId, false);
    if (work === null) return { error: "not_found" };
    const bursts = offOf(state).has(work.assignmentId)
      ? []
      : (BURSTS.get(state) ?? [])
          .filter((b) => b.documentId === work.documentId)
          .map(({ documentId: _work, ...burst }) => burst);
    return { status: 200, body: { bursts } };
  },
  "work.input-rhythm.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = workOf(state, account, params.documentId, true);
    if (work === null) return { error: "not_found" };
    const list = BURSTS.get(state) ?? [];
    const kept = list.filter((b) => b.documentId !== work.documentId);
    BURSTS.set(state, kept);
    return { status: 200, body: { deleted: list.length - kept.length } };
  },
  "work.input-rhythm-setting.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = workOf(state, account, params.documentId, false);
    if (work === null) return { error: "not_found" };
    return { status: 200, body: { enabled: !offOf(state).has(work.assignmentId) } };
  },
  "teacher.input-rhythm.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    return { status: 200, body: { enabled: !offOf(state).has(assignmentId) } };
  },
  "teacher.input-rhythm.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    if (body.enabled) offOf(state).delete(assignmentId);
    else offOf(state).add(assignmentId);
    return { status: 200, body: { enabled: body.enabled } };
  },
};
