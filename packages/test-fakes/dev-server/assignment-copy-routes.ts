// Copying an assignment on the dev fake server (teacher.assignment-copy.post,
// SRV-1904, P-D4): the teacher of the source and of the target course gets a
// new assignment at version 1 with the source's current content and, if sent,
// new dates. Nothing about students is copied: no acknowledgment, read,
// work language exception or work. The real rules are
// institution.copy_assignment (20261202190400).
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { parseInstant, teachesCourse, type State } from "./state.ts";

const AI_POLICIES = ["prohibited", "partially_allowed", "encouraged"] as const;

/** The key of each copy and what it was made with, per fake state. */
const COPIES = new WeakMap<State, Map<string, { id: string; content: string }>>();

export const ASSIGNMENT_COPY_HANDLERS: Handlers = {
  "teacher.assignment-copy.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const source = state.assignments.find((a) => a.id === params.assignmentId.toLowerCase());
    const from = state.courses.find((c) => c.id === source?.courseId);
    const to = state.courses.find((c) => c.id === body.courseId.toLowerCase());
    if (
      source === undefined ||
      from === undefined ||
      to === undefined ||
      !teachesCourse(from, account) ||
      !teachesCourse(to, account)
    )
      return { error: "not_found" };
    const opensAt =
      body.opensAt === undefined ? source.content.opensAt : parseInstant(body.opensAt);
    const dueAt = body.dueAt === undefined ? source.content.dueAt : parseInstant(body.dueAt);
    if (
      opensAt === null ||
      dueAt === null ||
      opensAt >= dueAt ||
      AI_POLICIES.indexOf(source.content.aiPolicy) > AI_POLICIES.indexOf(to.aiPolicy)
    )
      return { error: "invalid_input" };
    // The groups are the source course's and stay there.
    const content = { ...source.content, opensAt, dueAt };
    delete content.groupIds;
    // The work language is copied too and lives outside the content, so a
    // replay after it changed is a conflict, as in institution.copy_assignment.
    const text = JSON.stringify([to.id, content, source.language]);
    let seen = COPIES.get(state);
    if (seen === undefined) COPIES.set(state, (seen = new Map()));
    const key = `${account.id}:${body.requestKey.toLowerCase()}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      return earlier.content === text
        ? { status: 201, body: { id: earlier.id, versionNo: 1 } }
        : { error: "conflict" };
    }
    const id = randomUUID();
    seen.set(key, { id, content: text });
    state.assignments.push({
      id,
      courseId: to.id,
      version: 1,
      content,
      language: source.language,
      acknowledged: new Map(),
      read: new Map(),
      studentLanguage: new Map(),
    });
    return { status: 201, body: { id, versionNo: 1 } };
  },
};
