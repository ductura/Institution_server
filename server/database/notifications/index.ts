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

type MessageSlotRow = {
  id: string;
  kind: string;
  targetId: string;
  documentId: string;
  slotId: string | null;
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
    // F4-MEN-R10-SRV: the notifications of a new message and of a slot that waits for an
    // answer. Identifiers only; institution.list_message_slot_notifications leaves a row out
    // when the caller no longer has the relation to the work. Up to 51 rows: one more than a page.
    listMessagesAndSlots: (token: string, before: string | null) =>
      withActor(token, async (tx) => {
        const result = await tx.query<MessageSlotRow>(
          `SELECT id, kind, target_id AS "targetId", document_id AS "documentId", slot_id AS "slotId",
                  created_at AS "createdAt", read_at AS "readAt"
             FROM institution.list_message_slot_notifications($1) ORDER BY created_at DESC, id DESC`,
          [before],
        );
        return result.rows.map(({ createdAt, readAt, ...row }) => ({
          ...row,
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
