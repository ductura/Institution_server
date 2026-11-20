import { type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { WorkMilestone } from "../../contracts/index.ts";
import type { WithActor } from "../index.ts";

type MilestoneRow = {
  id: string;
  title: string;
  description: string;
  due_at: Date | null;
  state: string;
};

function milestoneOf(row: MilestoneRow): Static<typeof WorkMilestone> {
  const milestone = {
    id: row.id,
    title: row.title,
    description: row.description,
    dueAt: row.due_at === null ? null : row.due_at.toISOString(),
    state: row.state,
  };
  if (!Value.Check(WorkMilestone, milestone)) throw new Error("Invalid work milestone");
  return milestone;
}

export function createWorkMilestones(withActor: WithActor) {
  return {
    list(token: string, documentId: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<MilestoneRow>(
          "SELECT * FROM app.read_work_milestones($1)",
          [documentId],
        );
        return rows.map(milestoneOf);
      });
    },
    changeDueAt(token: string, documentId: string, milestoneId: string, dueAt: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<MilestoneRow>(
          "SELECT * FROM app.set_work_milestone_due($1, $2, $3)",
          [documentId, milestoneId, dueAt],
        );
        const [row] = rows;
        if (rows.length !== 1 || row === undefined) throw new Error("Expected one work milestone");
        return milestoneOf(row);
      });
    },
  };
}
