// The rhythm of typing on the dev fake server (PIL-P1-RITAM-SRV, P-1 rule 4):
// the student who owns the work records bursts of gaps in milliseconds and
// deletes them; the owner and the readers of the work (readerOf) read the
// bursts and the state of the switch; only the teacher of the assignment's
// course switches it. While it is off nothing is recorded and nothing is read.
// The real rule is app.input_rhythm_* (20261213100300, 20261213110100). The
// bursts and the switch live in memory beside the state.
// PIL-P1-RITAM-PREDMET-SRV (20261214120000): a teacher of the course also
// switches the course; the assignment's switch, if set, overrides it; the
// teacher of the assignment clears it to give the course back.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { readerOf, teachesCourse, type Account, type State } from "./state.ts";

type Burst = { id: string; gapsMs: number[]; recordedAt: string; documentId: string };
const BURSTS = new WeakMap<object, Burst[]>();
type Switch = {
  enabled: boolean;
  source: "assignment" | "course" | "default";
  changedBy: { role: "teacher" | "mentor"; name: string | null } | null;
  changedAt: string | null;
};
// The assignment's switches by assignment id, the course's by "course:" + id.
const SWITCHES = new WeakMap<object, Map<string, Switch>>();
const DEFAULT: Switch = { enabled: true, source: "default", changedBy: null, changedAt: null };

const switchesOf = (state: State): Map<string, Switch> => {
  const map = SWITCHES.get(state) ?? new Map<string, Switch>();
  SWITCHES.set(state, map);
  return map;
};
const courseSwitchOf = (state: State, courseId: string | undefined): Switch =>
  switchesOf(state).get(`course:${courseId}`) ?? DEFAULT;
const switchOf = (state: State, assignmentId: string): Switch =>
  switchesOf(state).get(assignmentId) ??
  courseSwitchOf(state, state.assignments.find((a) => a.id === assignmentId)?.courseId);

function taughtCourse(state: State, account: Account | null, courseId: string): string | null {
  const course = state.courses.find((c) => c.id === courseId);
  return course !== undefined && account !== null && teachesCourse(course, account)
    ? course.id
    : null;
}
const changer = (account: Account) => ({
  role: "teacher" as const,
  name: `${account.givenName} ${account.familyName}`,
});

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
    if (!switchOf(state, work.assignmentId).enabled)
      return { status: 200, body: { recorded: false } };
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
    const bursts = !switchOf(state, work.assignmentId).enabled
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
    return { status: 200, body: switchOf(state, work.assignmentId) };
  },
  "teacher.input-rhythm.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    return { status: 200, body: switchOf(state, assignmentId) };
  },
  "teacher.input-rhythm.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    const next: Switch = {
      enabled: body.enabled,
      source: "assignment",
      changedBy: changer(account),
      changedAt: now.toISOString(),
    };
    switchesOf(state).set(assignmentId, next);
    return { status: 200, body: next };
  },
  "teacher.input-rhythm.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    switchesOf(state).delete(assignmentId);
    return { status: 200, body: switchOf(state, assignmentId) };
  },
  "teacher.course-input-rhythm.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const courseId = taughtCourse(state, account, params.courseId);
    if (courseId === null) return { error: "not_found" };
    return { status: 200, body: courseSwitchOf(state, courseId) };
  },
  "teacher.course-input-rhythm.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const courseId = taughtCourse(state, account, params.courseId);
    if (courseId === null) return { error: "not_found" };
    const next: Switch = {
      enabled: body.enabled,
      source: "course",
      changedBy: changer(account),
      changedAt: now.toISOString(),
    };
    switchesOf(state).set(`course:${courseId}`, next);
    return { status: 200, body: next };
  },
};
