import type { WithActor } from "./with-actor.ts";

type HistoryRow = {
  id: string;
  scope: string;
  previousDueAt: Date;
  dueAt: Date;
  reasonId: string;
  createdAt: Date;
};

const SQL = `SELECT id, scope, previous_due_at AS "previousDueAt", due_at AS "dueAt",
  reason_id AS "reasonId", created_at AS "createdAt"
  FROM institution.student_deadline_history($1::uuid) WITH ORDINALITY ORDER BY ordinality`;

export function createStudentDeadlineHistoryReader(withActor: WithActor) {
  return async (token: string, assignmentId: string) => {
    try {
      const extensions = await withActor(token, async (tx) => {
        const { rows } = await tx.query<HistoryRow>(SQL, [assignmentId]);
        return rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          previousDueAt: row.previousDueAt.toISOString(),
          dueAt: row.dueAt.toISOString(),
          reasonId: row.reasonId,
          createdAt: row.createdAt.toISOString(),
        }));
      });
      return { status: "read", extensions } as const;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && error.code;
      if (code === "ZD401") return { status: "unauthorized" } as const;
      if (code === "ZD403") return { status: "not_found" } as const;
      throw error;
    }
  };
}
