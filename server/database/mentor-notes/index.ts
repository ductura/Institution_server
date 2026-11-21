import type { WithActor } from "../index.ts";

type NoteRow = { id: string; body: string; created_at: Date };
const noteOf = ({ id, body, created_at }: NoteRow) => ({
  id,
  body,
  createdAt: created_at.toISOString(),
});

// The session and the active relationship are examined in the same snapshot
// as the rows. The left join distinguishes an empty list from denied access.
const READ = `SELECT app.current_user_id() IS NOT NULL AS authenticated,
    access.allowed, n.id, n.body, n.created_at
  FROM (SELECT institution.actor_mentorship_role($1::uuid) = 'teacher' AS allowed) access
  LEFT JOIN institution.mentor_note n ON access.allowed AND n.mentorship_id = $1::uuid
  ORDER BY n.created_at, n.id`;
const CREATE =
  "SELECT id, body, created_at FROM institution.create_mentor_note($1::uuid, $2::text)";

export function createMentorNotesStore(withActor: WithActor) {
  return {
    read: (token: string, id: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<
          { authenticated: boolean; allowed: boolean | null } & (NoteRow | { id: null })
        >(READ, [id]);
        const first = rows[0];
        if (!first) throw new Error("missing mentor notes result");
        if (!first.authenticated) return { status: "unauthorized" } as const;
        if (!first.allowed) return { status: "not_found" } as const;
        return {
          status: "found",
          notes: rows.filter((row) => row.id !== null).map(noteOf),
        } as const;
      }),
    create: (token: string, id: string, body: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<NoteRow>(CREATE, [id, body]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing created note");
        return noteOf(rows[0]);
      }),
  };
}
