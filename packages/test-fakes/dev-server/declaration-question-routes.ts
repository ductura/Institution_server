// SRV-IZJAVA-PITANJE: the teacher's optional question with the declaration in
// the dev fake server. The teacher of the assignment sets or removes it (none
// by default); every change is kept with its time, so an answer saved to an
// earlier question keeps that question's text. Invented texts only.
import { randomUUID } from "node:crypto";

import { isDeclarationQuestion } from "../../../server/domain/declaration/index.ts";
import type { Handlers } from "./server.ts";
import { teachesCourse, type State } from "./state.ts";

type Version = { questionId: string; text: string | null; changedAt: string };
const HISTORY = new WeakMap<State, Map<string, Version[]>>();

function historyOf(state: State, assignmentId: string): Version[] {
  let map = HISTORY.get(state);
  if (map === undefined) {
    map = new Map();
    HISTORY.set(state, map);
  }
  let list = map.get(assignmentId);
  if (list === undefined) {
    list = [];
    map.set(assignmentId, list);
  }
  return list;
}

/** The question in force for the student, or null. */
export function questionOf(
  state: State,
  assignmentId: string,
): { questionId: string; text: string } | null {
  const last = historyOf(state, assignmentId).at(-1);
  return last?.text == null ? null : { questionId: last.questionId, text: last.text };
}

/** The text of one question version of the assignment, or null. */
export function questionTextOf(state: State, assignmentId: string, questionId: string) {
  return historyOf(state, assignmentId).find((v) => v.questionId === questionId)?.text ?? null;
}

function settingOf(state: State, assignmentId: string) {
  const last = historyOf(state, assignmentId).at(-1);
  return { question: last?.text ?? null, changedAt: last?.changedAt ?? null };
}

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

export const DECLARATION_QUESTION_HANDLERS: Handlers = {
  "teacher.declaration-question.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    return { status: 200, body: settingOf(state, assignment.id) };
  },
  "teacher.declaration-question.put": ({ state, account, params, body, now }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    if (body.question !== null && !isDeclarationQuestion(body.question)) {
      return { error: "invalid_input" };
    }
    const current = settingOf(state, assignment.id);
    if (current.question === body.question) return { status: 200, body: current };
    historyOf(state, assignment.id).push({
      questionId: randomUUID(),
      text: body.question,
      changedAt: now.toISOString(),
    });
    return { status: 200, body: settingOf(state, assignment.id) };
  },
};
