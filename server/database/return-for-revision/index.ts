import type { WithActor } from "../index.ts";

// SRV-1606: the teacher returns a whole submitted work for revision.
// app.return_work_for_revision (20261213100600) decides; this only asks.

export type WorkReturn = {
  id: string;
  round: number;
  comment: string;
  revisionDueAt: string | null;
  returnedAt: string;
};

export type WorkReturnResult =
  | { status: "returned"; value: WorkReturn }
  | { status: "unauthorized" | "invalid" | "not_found" | "forbidden" | "not_submitted" };

type Row = {
  outcome: string;
  id: string | null;
  attempt: number | null;
  comment: string | null;
  revisionDueAt: Date | null;
  returnedAt: Date | null;
};

export type ReturnForRevision = {
  returnWork(
    token: string,
    documentId: string,
    comment: string,
    revisionDueAt: string | undefined,
  ): Promise<WorkReturnResult>;
};

const REFUSALS = new Set(["unauthorized", "invalid", "not_found", "forbidden", "not_submitted"]);

export function createReturnForRevision(withActor: WithActor): ReturnForRevision {
  return {
    returnWork(token, documentId, comment, revisionDueAt) {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(
          `SELECT outcome, return_id AS id, attempt, comment, revision_due_at AS "revisionDueAt",
                  returned_at AS "returnedAt"
             FROM app.return_work_for_revision($1, $2, $3)`,
          [documentId, comment, revisionDueAt ?? null],
        );
        const [row] = rows;
        if (rows.length !== 1 || row === undefined) throw new Error("Expected one outcome");
        if (row.outcome === "returned") {
          if (
            row.id === null ||
            row.attempt === null ||
            row.comment === null ||
            row.returnedAt === null
          ) {
            throw new Error("A return without its fields");
          }
          return {
            status: "returned",
            value: {
              id: row.id,
              round: row.attempt,
              comment: row.comment,
              revisionDueAt: row.revisionDueAt?.toISOString() ?? null,
              returnedAt: row.returnedAt.toISOString(),
            },
          } as const;
        }
        if (!REFUSALS.has(row.outcome)) throw new Error(`Unknown outcome ${row.outcome}`);
        return { status: row.outcome as Exclude<WorkReturnResult["status"], "returned"> };
      });
    },
  };
}
