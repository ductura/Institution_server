// Student routes of the dev fake server: own courses and assignments, the
// state of own works and who opened them (PRODUCT §5 rule 17). Only the
// caller's own memberships and works are ever read.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import type { Account, Assignment, State, WorkSource } from "./state.ts";

/** Assignments of the courses the account is a student in. */
export function studentAssignments(state: State, account: Account): Assignment[] {
  const courses = new Set(
    state.courses.filter((c) => c.studentIds.includes(account.id)).map((c) => c.id),
  );
  return state.assignments.filter((a) => courses.has(a.courseId));
}

function ownAssignment(state: State, account: Account, id: string): Assignment | undefined {
  return studentAssignments(state, account).find(
    (assignment) => assignment.id === id.toLowerCase(),
  );
}

export const STUDENT_HANDLERS: Handlers = {
  "student.assignments.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const own = studentAssignments(state, account);
    const courses = state.courses
      .filter((c) => c.studentIds.includes(account.id))
      .sort((a, b) => a.name.localeCompare(b.name, "hr") || a.id.localeCompare(b.id))
      .map((course) => ({
        id: course.id,
        name: course.name,
        assignments: own
          .filter((a) => a.courseId === course.id)
          .sort(
            (a, b) => a.content.dueAt.localeCompare(b.content.dueAt) || a.id.localeCompare(b.id),
          )
          .map((a) => ({
            id: a.id,
            title: a.content.title,
            dueAt: a.content.dueAt,
            noticeFirst: a.acknowledged.get(account.id)?.version !== a.version,
          })),
      }));
    return { status: 200, body: { courses } };
  },
  "student.assignment-work.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const assignments = studentAssignments(state, account)
      .map((a) => {
        const work = state.works.find((w) => w.assignmentId === a.id && w.studentId === account.id);
        const workState =
          work === undefined
            ? "not_started"
            : work.state === "submitted"
              ? "submitted"
              : "in_progress";
        return { assignmentId: a.id, workState } as const;
      })
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    return { status: 200, body: { assignments } };
  },
  "student.submission.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const work = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === account.id,
    );
    if (work === undefined || work.submittedAt === null)
      return { status: 200, body: { state: "none" } };
    if (work.submissionReceipt === null)
      return {
        status: 200,
        body: {
          state: "ceka",
          revision: work.revision,
          requestedAt: `${work.submittedAt.slice(0, -1)}000Z`,
        },
      };
    return { status: 200, body: { state: "potvrdeno", receipt: work.submissionReceipt } };
  },
  "student.assignment-requirements.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const { wordMin, wordMax } = assignment.content;
    const wordRange =
      wordMin !== null
        ? { min: wordMin, max: wordMax }
        : wordMax !== null
          ? { min: null, max: wordMax }
          : null;
    return { status: 200, body: { wordRange } };
  },
  "student.submission-notes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const notes = state.submissionNotes
      .filter((note) => note.assignmentId === assignment.id && note.studentId === account.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ id, text, createdAt }) => ({ id, text, createdAt }));
    return { status: 200, body: { notes } };
  },
  "student.submission-notes.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, body.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const note = { id: randomUUID(), text: body.text, createdAt: now.toISOString() };
    state.submissionNotes.push({ ...note, assignmentId: assignment.id, studentId: account.id });
    return { status: 201, body: note };
  },
  "student.work-sources.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const sources = state.workSources
      .filter((s) => s.assignmentId === assignment.id && s.studentId === account.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ assignmentId: _a, studentId: _s, ...source }) => source);
    return { status: 200, body: { sources } };
  },
  "student.work-sources.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    if (body.record.id !== params.sourceId) return { error: "invalid_input" };
    const mine = state.workSources.filter(
      (s) => s.assignmentId === assignment.id && s.studentId === account.id,
    );
    const old = mine.find((s) => s.id === params.sourceId);
    if (old?.requirement != null) return { error: "not_found" };
    if (old === undefined && mine.length >= 500) return { error: "invalid_input" };
    const at = now.toISOString();
    const source = {
      id: params.sourceId,
      // The wire checks the record's deep shape; this fake stores what it was sent.
      record: body.record as WorkSource["record"],
      doi: body.doi ?? null,
      isbn: body.isbn ?? null,
      undated: body.undated ?? false,
      requirement: null,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    state.workSources = state.workSources.filter((s) => s !== old);
    state.workSources.push({ ...source, assignmentId: assignment.id, studentId: account.id });
    return { status: 200 as const, body: source };
  },
  "student.work-sources.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const old = state.workSources.find(
      (s) =>
        s.assignmentId === assignment.id && s.studentId === account.id && s.id === params.sourceId,
    );
    if (old === undefined || old.requirement !== null) return { error: "not_found" };
    state.workSources = state.workSources.filter((s) => s !== old);
    return { status: 204 };
  },
  "student.access-log.get": ({ state, account, params, query }) => {
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (account === null || work === undefined || work.studentId !== account.id)
      return { error: "not_found" };
    const beforeAt = typeof query?.beforeAt === "string" ? query.beforeAt : null;
    const beforeId = typeof query?.beforeId === "string" ? query.beforeId : null;
    const continued = beforeAt !== null && beforeId !== null && !Number.isNaN(Date.parse(beforeAt));
    const entries = state.accessLog
      .filter((e) => e.documentId === work.documentId && (!continued || e.at < (beforeAt ?? "")))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((e) => {
        const reader = state.accounts.find((a) => a.id === e.readerId);
        return {
          id: e.id,
          at: e.at,
          role: e.role,
          surface: e.surface,
          reader:
            reader === undefined
              ? null
              : { givenName: reader.givenName, familyName: reader.familyName },
        };
      });
    return { status: 200, body: { entries, next: null, continued } };
  },
};
