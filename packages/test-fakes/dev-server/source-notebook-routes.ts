import { randomUUID } from "node:crypto";

import type { Account, State } from "./state.ts";
import type { Handlers } from "./server.ts";
import { studentAssignments } from "./student-routes.ts";

function sourceKey(state: State, account: Account, id: string, sourceId: string) {
  const work = state.works.find((w) => w.documentId === id && w.studentId === account.id);
  if (
    work === undefined ||
    !studentAssignments(state, account).some((a) => a.id === work.assignmentId)
  )
    return undefined;
  const source = state.workSources.find(
    (s) => s.id === sourceId && s.assignmentId === work.assignmentId && s.studentId === account.id,
  );
  if (source !== undefined) return `${source.assignmentId}:${source.studentId}:${source.id}`;
}

export const SOURCE_NOTE_HANDLERS = {
  "work.source-notes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const key = sourceKey(state, account, params.id, params.sourceId);
    if (key === undefined) return { error: "not_found" };
    const notes = (state.sourceNotes.get(key) ?? []).toSorted((a, b) => a.id.localeCompare(b.id));
    return { status: 200, body: { notes } };
  },
  "work.source-notes.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const key = sourceKey(state, account, params.id, params.sourceId);
    if (key === undefined) return { error: "not_found" };
    const notes = state.sourceNotes.get(key) ?? [];
    const { quote = null, page = null, note = null } = body;
    if (notes.length >= 100 || [quote, page, note].every((value) => value === null))
      return { error: "invalid_input" };
    const created = { id: randomUUID(), quote, page, note };
    state.sourceNotes.set(key, [...notes, created]);
    return { status: 201, body: created };
  },
  "work.source-notes.patch": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const key = sourceKey(state, account, params.id, params.sourceId);
    if (key === undefined) return { error: "not_found" };
    const notes = state.sourceNotes.get(key) ?? [];
    const { noteId, ...fields } = body;
    const index = notes.findIndex((n) => n.id === noteId);
    const previous = notes[index];
    if (previous === undefined) return { error: "not_found" };
    const updated = { ...previous, ...fields };
    if (
      Object.keys(fields).length === 0 ||
      [updated.quote, updated.page, updated.note].every((value) => value === null)
    )
      return { error: "invalid_input" };
    notes[index] = updated;
    return { status: 200, body: updated };
  },
  "work.source-notes.delete": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const key = sourceKey(state, account, params.id, params.sourceId);
    if (key === undefined) return { error: "not_found" };
    const notes = state.sourceNotes.get(key) ?? [];
    const remaining = notes.filter((note) => note.id !== query.noteId);
    if (remaining.length === notes.length) return { error: "not_found" };
    state.sourceNotes.set(key, remaining);
    return { status: 204 };
  },
} satisfies Partial<Handlers>;
