import type { WithActor } from "../index.ts";

type MilestoneRow = {
  id: string;
  title: string;
  description: string;
  dueAt: Date | null;
  state: "open" | "submitted" | "approved" | "returned";
};

function milestoneOf(row: MilestoneRow) {
  return { ...row, dueAt: row.dueAt?.toISOString() ?? null };
}

export function createWorkMilestones(withActor: WithActor) {
  return {
    list(token: string, documentId: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<MilestoneRow>(
          'SELECT id, title, description, due_at AS "dueAt", state FROM app.read_work_milestones($1)',
          [documentId],
        );
        return rows.map(milestoneOf);
      });
    },
    changeDueAt(token: string, documentId: string, milestoneId: string, dueAt: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<MilestoneRow>(
          'SELECT id, title, description, due_at AS "dueAt", state FROM app.set_work_milestone_due($1, $2, $3)',
          [documentId, milestoneId, dueAt],
        );
        const [row] = rows;
        if (rows.length !== 1 || row === undefined) throw new Error("Expected one work milestone");
        return milestoneOf(row);
      });
    },
  };
}
