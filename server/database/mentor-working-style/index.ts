import type { WithActor } from "../index.ts";

// F4-MEN-R09-SRV: each call is one RPC of the main database. The functions
// decide who may: ZD401 without a session, ZD403 for anyone who is no
// confirmed teacher (write) or has no mentorship in force with the mentor
// (read), ZD422 for a text out of bounds; the HTTP adapter maps them.
const SET = "SELECT body, updated_at FROM institution.set_mentor_working_style($1::text)";
const READ = "SELECT body, updated_at FROM institution.read_mentor_working_style($1::uuid)";

type Row = { body: string; updated_at: Date };
const textOf = ({ body, updated_at }: Row) => ({ text: body, updatedAt: updated_at.toISOString() });

export function createMentorWorkingStyleStore(withActor: WithActor) {
  return {
    /** The mentor's own text, written or replaced. */
    set: (token: string, text: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(SET, [text]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing mentor working style");
        return textOf(rows[0]);
      }),
    /** The text of a mentor the caller is mentored by; nulls while none is written. */
    read: (token: string, teacherId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(READ, [teacherId]);
        return rows[0] ? textOf(rows[0]) : ({ text: null, updatedAt: null } as const);
      }),
  };
}
