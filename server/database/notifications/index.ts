import type { WithActor } from "../index.ts";

type NotificationRow = {
  id: string;
  kind: string;
  targetId: string;
  createdAt: Date;
  readAt: Date | null;
};

type RevisionRow = {
  id: string;
  targetId: string;
  documentId: string;
  comment: string;
  revisionDueAt: Date | null;
  createdAt: Date;
  readAt: Date | null;
};

export function createNotifications(withActor: WithActor) {
  return {
    list: (token: string, before: string | null, reminderSeconds: number) =>
      withActor(token, async (tx) => {
        const result = await tx.query<NotificationRow>(
          `SELECT id, kind, target_id AS "targetId", created_at AS "createdAt", read_at AS "readAt"
           FROM institution.list_notifications($1, $2) ORDER BY created_at DESC, id DESC`,
          [before, reminderSeconds],
        );
        return result.rows.map(({ createdAt, readAt, ...row }) => ({
          ...row,
          createdAt: createdAt.toISOString(),
          readAt: readAt === null ? null : readAt.toISOString(),
        }));
      }),
    // SRV-1607: the notifications of work returned for revision. The inbox rows come from
    // institution.list_revision_notifications (the caller's own); the work, the comment
    // and the due date are read from the return itself with the caller's rights, so only
    // the student owner reads them. Up to 51 rows: one more than a page.
    listReturnedForRevision: (token: string, before: string | null) =>
      withActor(token, async (tx) => {
        const result = await tx.query<RevisionRow>(
          `SELECT n.id, n.target_id AS "targetId", r.document_id AS "documentId", r.comment,
                  r.revision_due_at AS "revisionDueAt", n.created_at AS "createdAt", n.read_at AS "readAt"
             FROM institution.list_revision_notifications($1) n
             JOIN evidence.submission_return r ON r.id = n.return_id
            ORDER BY n.created_at DESC, n.id DESC`,
          [before],
        );
        return result.rows.map(({ createdAt, readAt, revisionDueAt, ...row }) => ({
          ...row,
          revisionDueAt: revisionDueAt === null ? null : revisionDueAt.toISOString(),
          createdAt: createdAt.toISOString(),
          readAt: readAt === null ? null : readAt.toISOString(),
        }));
      }),
    markRead: (token: string, id: string) =>
      withActor(token, async (tx) => {
        const result = await tx.query<{ updated: boolean }>(
          "SELECT institution.read_notification($1) AS updated",
          [id],
        );
        const updated = result.rows[0]?.updated;
        if (result.rows.length !== 1 || typeof updated !== "boolean")
          throw new Error("unexpected notification read result");
        return updated;
      }),
  };
}
