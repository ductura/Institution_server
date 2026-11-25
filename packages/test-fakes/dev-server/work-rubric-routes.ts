import { latestRubricIds } from "./assignment-rubric-routes.ts";
import type { Handlers } from "./server.ts";
import { taughtWork } from "./teacher-routes.ts";
import type { State } from "./state.ts";

// SRV-V17-RUBRIC-LEVEL: the teacher's marks of a level per rubric criterion on the dev fake
// server. Only a teacher of the work reads and writes her own marks, bound to the latest rubric
// version (version 0 and the six default criteria while none is set); a student, another teacher,
// an unknown work and a criterion outside the latest version read the same 404. The real rules
// are 20261219270000_work_rubric_level.sql.
type Mark = { level: 0 | 1 | 2 | null; note: string | null };

// Keyed by the assignments array, which a reset of the state replaces (the State object itself is kept).
const marks = new WeakMap<object, Map<string, Mark>>();

const keyOf = (accountId: string, documentId: string, version: number, criterionId: string) =>
  `${accountId}:${documentId}:${version}:${criterionId}`;

function assignmentOfWork(state: State, documentId: string): string | undefined {
  return state.works.find((work) => work.documentId === documentId)?.assignmentId;
}

export const WORK_RUBRIC_HANDLERS: Handlers = {
  "teacher.work-rubric.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = assignmentOfWork(state, params.documentId);
    if (assignmentId === undefined || !taughtWork(state, account, params.documentId)) {
      return { error: "not_found" };
    }
    const { version, ids } = latestRubricIds(state, assignmentId);
    const stored = marks.get(state.assignments);
    return {
      status: 200,
      body: {
        rubricVersion: version,
        marks: ids.map((criterionId) => {
          const mark = stored?.get(keyOf(account.id, params.documentId, version, criterionId));
          return { criterionId, level: mark?.level ?? null, note: mark?.note ?? null };
        }),
      },
    };
  },
  "teacher.work-rubric-mark.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = assignmentOfWork(state, params.documentId);
    if (assignmentId === undefined || !taughtWork(state, account, params.documentId)) {
      return { error: "not_found" };
    }
    const { version, ids } = latestRubricIds(state, assignmentId);
    if (!ids.includes(params.criterionId)) return { error: "not_found" };
    if (body.note !== null && body.note.trim() === "") return { error: "invalid_input" };
    const all = marks.get(state.assignments) ?? new Map<string, Mark>();
    const key = keyOf(account.id, params.documentId, version, params.criterionId);
    if (body.level === null && body.note === null) all.delete(key);
    else all.set(key, { level: body.level, note: body.note });
    marks.set(state.assignments, all);
    return {
      status: 200,
      body: { criterionId: params.criterionId, level: body.level, note: body.note },
    };
  },
};
