import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

// F4-MEN-R09-SRV: the mentor's "Kako mentor radi" text, one per teacher account.
// Only a teacher writes; only a student with a mentorship of that mentor reads,
// and anyone else reads 404, as the server does (C-23).
// Keyed by the mentorships array, which a reset (POST /__lazni/ponovno) replaces,
// so a reset also forgets every text.
const STYLES = new WeakMap<object, Map<string, { text: string; updatedAt: string }>>();
const stylesOf = (state: State) => {
  const known = STYLES.get(state.mentorships);
  if (known !== undefined) return known;
  const created = new Map<string, { text: string; updatedAt: string }>();
  STYLES.set(state.mentorships, created);
  return created;
};

export const MENTOR_WORKING_STYLE_HANDLERS: Handlers = {
  "mentorship.working-style.put": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("teacher")) return { error: "forbidden" };
    const stored = { text: body.text as string, updatedAt: new Date().toISOString() };
    stylesOf(state).set(account.id, stored);
    return { status: 200, body: stored };
  },
  "mentorship.working-style.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const teacherId = params.teacherId.toLowerCase();
    const mentored = state.mentorships.some(
      (m) => m.mentorId === teacherId && m.studentId === account.id,
    );
    if (!mentored) return { error: "not_found" };
    return { status: 200, body: stylesOf(state).get(teacherId) ?? { text: null, updatedAt: null } };
  },
};
