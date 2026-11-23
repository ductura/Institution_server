// PIL-K-IZJAVA-SRV: the required declaration in the dev fake server. The
// teacher of the assignment turns it on or off (off by default); while it is
// on, the second major of the submission refuses a work whose declaration is
// not confirmed for its current revision with 409 declaration_required, and
// writes nothing. Otherwise it is the fake's submission.
import type { Handlers } from "./server.ts";
import { EVIDENCE_HANDLERS } from "./evidence-routes.ts";
import { teachesCourse, type State } from "./state.ts";
import { declarationConfirmedFor } from "./statement-routes.ts";

type Setting = { required: boolean; changedAt: string | null };
const SETTINGS = new WeakMap<State, Map<string, Setting>>();

function settingsOf(state: State): Map<string, Setting> {
  let map = SETTINGS.get(state);
  if (map === undefined) {
    map = new Map();
    SETTINGS.set(state, map);
  }
  return map;
}

const settingOf = (state: State, assignmentId: string): Setting =>
  settingsOf(state).get(assignmentId) ?? { required: false, changedAt: null };

function taught(state: State, account: Parameters<typeof teachesCourse>[1] | null, id: string) {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment
    : null;
}

const submit = EVIDENCE_HANDLERS["submission.submit.post"]!;

export const DECLARATION_REQUIRED_HANDLERS: Handlers = {
  "teacher.declaration-required.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    return { status: 200, body: settingOf(state, assignment.id) };
  },
  "teacher.declaration-required.put": ({ state, account, params, body, now }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const current = settingOf(state, assignment.id);
    if (current.required === body.required) return { status: 200, body: current };
    const next = { required: body.required, changedAt: now.toISOString() };
    settingsOf(state).set(assignment.id, next);
    return { status: 200, body: next };
  },
  "submission.submit-second.post": (ctx) => {
    const { state, account, body } = ctx;
    const work = state.works.find(
      (w) => w.documentId === body.documentId && w.studentId === account?.id,
    );
    if (
      work !== undefined &&
      work.submittedAt === null &&
      settingOf(state, work.assignmentId).required &&
      !declarationConfirmedFor(state, work)
    ) {
      return { error: "declaration_required" };
    }
    return submit(ctx as never) as never;
  },
};
