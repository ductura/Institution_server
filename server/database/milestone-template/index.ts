import type { WithActor } from "../index.ts";

/**
 * SRV-1521: the template of milestones of an institution (a version is only ever
 * added) and the plan of milestones of one work. The database decides who may
 * (administrator of the institution, mentor of the work, owner and teachers of the
 * work to read) and raises ZD401, ZD403, ZD404, ZD409 and ZD422; they are not caught
 * here, the HTTP edge maps them. Nothing in this port comes from the caller but the
 * session token, the document and the fields of the change.
 */

export type MilestoneSubmits = "topic_text" | "current_version";

export type MilestoneTemplateItem = {
  title: string;
  relativeDue?: number | undefined;
  submits: MilestoneSubmits;
};

export type MilestoneTemplateVersion = {
  version: number;
  effectiveFrom: string;
  requireFinalStageApproval: boolean;
  milestones: MilestoneTemplateItem[];
};

export type PlanItem = {
  id: string;
  position: number;
  title: string;
  dueAt: string | null;
  submits: MilestoneSubmits;
};

type VersionRow = {
  version: number;
  requireFinalStageApproval: boolean;
  milestones: MilestoneTemplateItem[];
  createdAt: Date;
};
type PlanRow = {
  id: string;
  position: number;
  title: string;
  dueAt: Date | null;
  submits: MilestoneSubmits;
};

const PLAN_COLUMNS = `id, position, title, due_at AS "dueAt", submits`;

function planOf(row: PlanRow): PlanItem {
  return { ...row, dueAt: row.dueAt?.toISOString() ?? null };
}

export function createMilestoneTemplate(withActor: WithActor) {
  function plan(token: string, sql: string, values: unknown[]) {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM ${sql}`, values);
      return rows.map(planOf);
    });
  }
  return {
    /** The versions of the own institution in ascending order; an administrator only. */
    versions(token: string): Promise<MilestoneTemplateVersion[]> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<VersionRow>(
          `SELECT version, require_final_stage_approval AS "requireFinalStageApproval", milestones,
                  created_at AS "createdAt"
             FROM app.read_milestone_template()`,
          [],
        );
        return rows.map((row, index) => {
          if (row.version !== index + 1 || !(row.createdAt instanceof Date)) {
            throw new Error("invalid milestone template chain");
          }
          return {
            version: row.version,
            effectiveFrom: row.createdAt.toISOString(),
            requireFinalStageApproval: row.requireFinalStageApproval,
            milestones: row.milestones,
          };
        });
      });
    },
    /** Adds the next version; the version number is the database's. */
    publish(
      token: string,
      expectedVersion: number,
      requireFinalStageApproval: boolean,
      milestones: readonly MilestoneTemplateItem[],
    ): Promise<number> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<{ version: number }>(
          "SELECT app.publish_milestone_template($1::integer, $2::boolean, $3::jsonb) AS version",
          [expectedVersion, requireFinalStageApproval, JSON.stringify(milestones)],
        );
        const version = rows[0]?.version;
        if (rows.length !== 1 || version !== expectedVersion + 1) {
          throw new Error("invalid published milestone template version");
        }
        return version;
      });
    },
    plan(token: string, documentId: string) {
      return plan(token, "app.read_work_milestone_plan($1)", [documentId]);
    },
    add(
      token: string,
      documentId: string,
      milestone: { title: string; dueAt?: string | undefined; submits: MilestoneSubmits },
    ) {
      return plan(token, "app.add_work_milestone($1, $2, $3, $4)", [
        documentId,
        milestone.title,
        milestone.dueAt ?? null,
        milestone.submits,
      ]);
    },
    applyTemplate(token: string, documentId: string) {
      return plan(token, "app.apply_milestone_template_to_work($1)", [documentId]);
    },
  };
}

export type MilestoneTemplate = ReturnType<typeof createMilestoneTemplate>;
