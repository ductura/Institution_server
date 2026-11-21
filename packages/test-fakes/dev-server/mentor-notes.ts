import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import type { Account, State } from "./state.ts";

function mentorshipOf(state: State, account: Account, id: string) {
  if (!account.roles.includes("teacher")) return undefined;
  return state.mentorships.find((m) => m.id === id.toLowerCase() && m.mentorId === account.id);
}

export const MENTOR_NOTES_HANDLERS: Handlers = {
  "mentorship.notes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const mentorship = mentorshipOf(state, account, params.id);
    if (mentorship === undefined) return { error: "not_found" };
    const notes = state.mentorNotes
      .filter((note) => note.mentorshipId === mentorship.id && note.mentorId === account.id)
      .map(({ id, body, createdAt }) => ({ id, body, createdAt }));
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { status: 200, body: { notes } };
  },
  "mentorship.notes.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const mentorship = mentorshipOf(state, account, params.id);
    if (mentorship === undefined) return { error: "not_found" };
    const note = { id: randomUUID(), body: body.body, createdAt: new Date().toISOString() };
    state.mentorNotes.push({ ...note, mentorshipId: mentorship.id, mentorId: account.id });
    return { status: 201, body: note };
  },
};
