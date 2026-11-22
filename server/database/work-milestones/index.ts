import type { WithActor } from "../index.ts";

type LegacyRow = {
  id: string;
  title: string;
  description: string;
  dueAt: Date | null;
  state: "open" | "submitted" | "approved" | "returned";
};

function legacyOf(row: LegacyRow) {
  return { ...row, dueAt: row.dueAt?.toISOString() ?? null };
}

type MilestoneRow = {
  id: string;
  title: string;
  description: string;
  dueAt: Date | null;
  state: "not_submitted" | "submitted" | "revision_requested" | "approved";
  everSubmitted: boolean;
  submittedRevisionId: string | null;
  submittedAt: Date | null;
  revisionComment: string | null;
  revisionDueAt: Date | null;
  revisionRequestedAt: Date | null;
  approvedAt: Date | null;
  approvalMessage: string | null;
};

const COLUMNS = `id, title, description, due_at AS "dueAt", state, ever_submitted AS "everSubmitted",
  submitted_revision AS "submittedRevisionId", submitted_at AS "submittedAt",
  revision_comment AS "revisionComment", revision_due_at AS "revisionDueAt",
  revision_requested_at AS "revisionRequestedAt", approved_at AS "approvedAt",
  approval_message AS "approvalMessage"`;

const iso = (date: Date | null) => date?.toISOString() ?? null;

function milestoneOf(row: MilestoneRow) {
  return {
    ...row,
    dueAt: iso(row.dueAt),
    // bigint arrives as a string; the revision never exceeds 2^53 - 1 (CHECK in the table).
    submittedRevisionId: row.submittedRevisionId === null ? null : Number(row.submittedRevisionId),
    submittedAt: iso(row.submittedAt),
    revisionDueAt: iso(row.revisionDueAt),
    revisionRequestedAt: iso(row.revisionRequestedAt),
    approvedAt: iso(row.approvedAt),
  };
}

export function createWorkMilestones(withActor: WithActor) {
  function one(token: string, sql: string, values: unknown[]) {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<MilestoneRow>(`SELECT ${COLUMNS} FROM ${sql}`, values);
      const [row] = rows;
      if (rows.length !== 1 || row === undefined) throw new Error("Expected one work milestone");
      return milestoneOf(row);
    });
  }
  return {
    list(token: string, documentId: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<LegacyRow>(
          'SELECT id, title, description, due_at AS "dueAt", state FROM app.read_work_milestones($1)',
          [documentId],
        );
        return rows.map(legacyOf);
      });
    },
    changeDueAt(token: string, documentId: string, milestoneId: string, dueAt: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<LegacyRow>(
          'SELECT id, title, description, due_at AS "dueAt", state FROM app.set_work_milestone_due($1, $2, $3)',
          [documentId, milestoneId, dueAt],
        );
        const [row] = rows;
        if (rows.length !== 1 || row === undefined) throw new Error("Expected one work milestone");
        return legacyOf(row);
      });
    },
    listStates(token: string, documentId: string) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<MilestoneRow>(
          `SELECT ${COLUMNS} FROM app.read_work_milestone_states($1)`,
          [documentId],
        );
        return rows.map(milestoneOf);
      });
    },
    change(
      token: string,
      documentId: string,
      milestoneId: string,
      change: { title?: string | undefined; dueAt?: string | undefined },
    ) {
      return one(token, "app.change_work_milestone($1, $2, $3, $4)", [
        documentId,
        milestoneId,
        change.title ?? null,
        change.dueAt ?? null,
      ]);
    },
    submit(token: string, documentId: string, milestoneId: string) {
      return one(token, "app.submit_work_milestone($1, $2)", [documentId, milestoneId]);
    },
    requestRevision(
      token: string,
      documentId: string,
      milestoneId: string,
      comment: string,
      revisionDueAt: string | undefined,
    ) {
      return one(token, "app.request_work_milestone_revision($1, $2, $3, $4)", [
        documentId,
        milestoneId,
        comment,
        revisionDueAt ?? null,
      ]);
    },
    approve(token: string, documentId: string, milestoneId: string, message: string | undefined) {
      return one(token, "app.approve_work_milestone($1, $2, $3)", [
        documentId,
        milestoneId,
        message ?? null,
      ]);
    },
    async remove(token: string, documentId: string, milestoneId: string) {
      await withActor(token, (tx) =>
        tx.query("SELECT app.delete_work_milestone($1, $2)", [documentId, milestoneId]),
      );
    },
  };
}
