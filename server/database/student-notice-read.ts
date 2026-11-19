// SRV-10 (Ductus#2028 c.7008147932, PO-7): the student marks the notice of an
// assignment as read, over institution.mark_notice_read (20261119130000,
// SRV-06). The contract takes the version the student saw; the RPC takes only
// the assignment, so one withActor transaction reads the current version under
// the caller's RLS first and records nothing when it is another (conflict).
// An assignment the caller cannot read, and ZD403 of the RPC for anyone who is
// not its student, are the same not_found (C-23). The answer never carries a
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
          const current = await tx.query<{ currentVersion: unknown }>(CURRENT, [assignmentId]);
          if (current.rows.length !== 1) return { status: "not_found" };
          if (current.rows[0]!.currentVersion !== versionNo) return { status: "conflict" };
          const marked = await tx.query<{ readAt: unknown }>(MARK, [assignmentId]);
          const readAt = marked.rows.length === 1 ? marked.rows[0]!.readAt : undefined;
          if (!(readAt instanceof Date) || Number.isNaN(readAt.getTime())) {
            return { status: "unavailable" };
          }
          return { status: "read", readAt: readAt.toISOString() };
        });
      } catch (thrown) {
        const code = codeOf(thrown);
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return { status: "not_found" };
        return { status: "unavailable" };
      }
    },
  };
}
