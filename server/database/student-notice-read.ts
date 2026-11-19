// SRV-10 (Ductus#2028 c.7008147932, PO-7): the student marks the notice of an
// assignment as read, over institution.mark_notice_read (20261119130000,
// SRV-06). The contract takes the version the student saw; the RPC takes only
// the assignment, so one withActor transaction (READ COMMITTED) does it in
// order: the actor first (no live session is unauthenticated, never the
// not_found of an assignment RLS hides); the current version under the
// caller's RLS (another is conflict, nothing recorded); the mark; then the
// current version once more. A version published between the two reads rolls
// the mark back and is conflict too, so a read is kept only for a version that
// was current after it was written (Codex on #371). An assignment the caller
// cannot read, and ZD403 of the RPC for anyone who is not its student, are the
// same not_found (C-23). The answer never carries a
// database message or SQLSTATE; it is a closed status, mapped by the route.
import type { WithActor } from "./with-actor.ts";

export type NoticeReadOutcome =
  | { readonly status: "read"; readonly readAt: string }
  | { readonly status: "unauthenticated" | "not_found" | "conflict" | "unavailable" };

export type StudentNoticeRead = {
  markRead(token: string, assignmentId: string, versionNo: number): Promise<NoticeReadOutcome>;
};

const CURRENT =
  'SELECT a.current_version AS "currentVersion" FROM institution.assignment a WHERE a.id = $1::uuid';
const MARK = 'SELECT institution.mark_notice_read($1::uuid) AS "readAt"';
const ACTOR = 'SELECT user_id AS "userId" FROM app.current_actor()';

/** Thrown inside the transaction so withActor rolls the mark back. */
class VersionMoved extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

export function createStudentNoticeRead(withActor: WithActor): StudentNoticeRead {
  return {
    async markRead(token, assignmentId, versionNo) {
      try {
        return await withActor(token, async (tx): Promise<NoticeReadOutcome> => {
          const actor = await tx.query<{ userId: unknown }>(ACTOR);
          if (typeof actor.rows[0]?.userId !== "string") return { status: "unauthenticated" };
          const version = async () =>
            (await tx.query<{ currentVersion: unknown }>(CURRENT, [assignmentId])).rows;
          const before = await version();
          if (before.length !== 1) return { status: "not_found" };
          if (before[0]!.currentVersion !== versionNo) return { status: "conflict" };
          const marked = await tx.query<{ readAt: unknown }>(MARK, [assignmentId]);
          const readAt = marked.rows.length === 1 ? marked.rows[0]!.readAt : undefined;
          if (!(readAt instanceof Date) || Number.isNaN(readAt.getTime())) {
            return { status: "unavailable" };
          }
          const after = await version();
          if (after.length !== 1 || after[0]!.currentVersion !== versionNo)
            throw new VersionMoved();
          return { status: "read", readAt: readAt.toISOString() };
        });
      } catch (thrown) {
        if (thrown instanceof VersionMoved) return { status: "conflict" };
        const code = codeOf(thrown);
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return { status: "not_found" };
        return { status: "unavailable" };
      }
    },
  };
}
