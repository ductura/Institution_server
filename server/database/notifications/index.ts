import type { WithActor } from "../index.ts";

type NotificationRow = {
  id: string;
  kind: string;
  targetId: string;
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
