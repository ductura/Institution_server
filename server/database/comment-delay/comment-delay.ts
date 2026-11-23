// SRV-1703 (M6.7, Ductus#2052; D-51, N-05): the database port of a teacher's
// delayed comments and of the last reviewed revision of a work
// (20261129100200). Each call is one withActor transaction over one RPC of
// schema collaboration; the RPCs decide who may (the teacher of the work, and
// for a draft only its author) and a student reaches none of them. The answer
// is a closed status, never a database message or SQLSTATE: ZD401 is
// unauthenticated, ZD403 not_found (one answer for "not yours", "not there"
// and "no relation", C-23), ZD409 conflict, ZD422 invalid, anything else
// unavailable. A row of an unexpected shape is unavailable too. Nothing here
// reads or writes a document, a revision, a segment or a receipt.
import type { ActorTransaction, WithActor } from "../index.ts";

export type CommentDraft = {
  readonly threadId: string;
  readonly commentId: string;
  readonly position: number;
  readonly text: string;
  /** The anchor of the thread as stored; null for a general comment. */
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly state: "open" | "answered" | "resolved";
  readonly createdWindow: string;
};

export type CommentDelayRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "conflict" | "unavailable";
};
export type CommentDelayResult<T> = ({ readonly status: "ok" } & T) | CommentDelayRefusal;

/** The reviewed revision (null before the first review) and the current one. */
export type WorkReviewState = {
  readonly reviewedRevision: number | null;
  readonly currentRevision: number;
};

export type CommentDelay = {
  createDraft(
    token: string,
    documentId: string,
    text: string,
    anchor: Readonly<Record<string, unknown>>,
  ): Promise<CommentDelayResult<{ threadId: string }>>;
  replyDraft(
    token: string,
    documentId: string,
    threadId: string,
    text: string,
  ): Promise<CommentDelayResult<{ commentId: string }>>;
  listDrafts(
    token: string,
    documentId: string,
  ): Promise<CommentDelayResult<{ drafts: readonly CommentDraft[] }>>;
  discardDraft(token: string, commentId: string): Promise<CommentDelayResult<object>>;
  publish(token: string, documentId: string): Promise<CommentDelayResult<{ published: number }>>;
  /**
   * publish, but only when draftIds are exactly the comment ids of the caller's
   * drafts on the work (any case); otherwise conflict and nothing is published.
   */
  publishListed(
    token: string,
    documentId: string,
    draftIds: readonly string[],
  ): Promise<CommentDelayResult<{ published: number }>>;
  markReviewed(
    token: string,
    documentId: string,
  ): Promise<CommentDelayResult<{ reviewedRevision: number; reviewedAt: string }>>;
  reviewState(token: string, documentId: string): Promise<CommentDelayResult<WorkReviewState>>;
};

const SQL = {
  createDraft: "SELECT collaboration.create_comment_draft($1, $2, $3::jsonb) AS id",
  replyDraft: "SELECT collaboration.reply_comment_draft($1, $2::uuid, $3) AS id",
  listDrafts:
    'SELECT thread_id AS "threadId", comment_id AS "commentId", comment_position AS position, body AS text, anchor, state, created_window AS "createdWindow" FROM collaboration.list_comment_drafts($1)',
  discardDraft: "SELECT collaboration.discard_comment_draft($1::uuid)",
  publish: "SELECT collaboration.publish_comments($1) AS published",
  // The key of create, discard and publish_comments, so no draft of this teacher on this work
  // is written or discarded between the list and the publish of one transaction.
  lockDrafts:
    "SELECT pg_advisory_xact_lock(hashtextextended('comment_draft:' || $1::uuid || app.current_user_id(), 0))",
  markReviewed:
    'SELECT reviewed_revision::text AS "reviewedRevision", reviewed_at AS "reviewedAt" FROM collaboration.mark_work_reviewed($1)',
  reviewState:
    'SELECT reviewed_revision::text AS "reviewedRevision", current_revision::text AS "currentRevision" FROM collaboration.get_work_review($1)',
} as const;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}
/** Thrown inside the transaction to roll it back as a conflict. */
class Conflict extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): CommentDelayRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD409") return { status: "conflict" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Malformed();
  return value;
};
const instant = (value: unknown): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
};
/** A bigint column read as text: a safe integer, or the call is unavailable. */
const revision = (value: unknown): number => {
  const n = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Malformed();
  return n;
};

function toDraft(row: Record<string, unknown>): CommentDraft {
  const { anchor, state, position } = row;
  if (anchor !== null && (typeof anchor !== "object" || Array.isArray(anchor))) {
    throw new Malformed();
  }
  if (state !== "open" && state !== "answered" && state !== "resolved") throw new Malformed();
  if (!Number.isSafeInteger(position)) throw new Malformed();
  return {
    threadId: text(row.threadId),
    commentId: text(row.commentId),
    position: position as number,
    text: text(row.text),
    anchor: anchor as Record<string, unknown> | null,
    state,
    createdWindow: instant(row.createdWindow),
  };
}

export function createCommentDelay(withActor: WithActor): CommentDelay {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | CommentDelayRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      if (thrown instanceof Conflict) return { status: "conflict" };
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;
  const one = async (tx: ActorTransaction, sql: string, params: unknown[]) => {
    const rows = await rowsOf(tx, sql, params);
    if (rows.length !== 1) throw new Malformed();
    return rows[0]!;
  };

  const published = async (tx: ActorTransaction, documentId: string) => {
    const count = (await one(tx, SQL.publish, [documentId])).published;
    if (!Number.isSafeInteger(count) || (count as number) < 1) throw new Malformed();
    return count as number;
  };

  return {
    createDraft: (token, documentId, body, anchor) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        threadId: text(
          (await one(tx, SQL.createDraft, [documentId, body, JSON.stringify(anchor)])).id,
        ),
      })),
    replyDraft: (token, documentId, threadId, body) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        commentId: text((await one(tx, SQL.replyDraft, [documentId, threadId, body])).id),
      })),
    listDrafts: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        drafts: (await rowsOf(tx, SQL.listDrafts, [documentId])).map(toDraft),
      })),
    discardDraft: (token, commentId) =>
      run(token, async (tx) => {
        await rowsOf(tx, SQL.discardDraft, [commentId]);
        return { status: "ok" as const };
      }),
    publish: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        published: await published(tx, documentId),
      })),
    // The list and the publish run under the advisory lock the draft functions
    // take, so a discard and a new draft cannot fall between them; a count
    // other than the list still rolls everything back.
    publishListed: (token, documentId, draftIds) =>
      run(token, async (tx) => {
        await rowsOf(tx, SQL.lockDrafts, [documentId]);
        const seen = new Set(draftIds.map((id) => id.toLowerCase()));
        const drafts = (await rowsOf(tx, SQL.listDrafts, [documentId])).map(toDraft);
        const own = new Set(drafts.map((d) => d.commentId.toLowerCase()));
        if (
          seen.size !== draftIds.length ||
          own.size !== seen.size ||
          [...own].some((id) => !seen.has(id))
        ) {
          throw new Conflict();
        }
        const count = await published(tx, documentId);
        if (count !== own.size) throw new Conflict();
        return { status: "ok" as const, published: count };
      }),
    markReviewed: (token, documentId) =>
      run(token, async (tx) => {
        const row = await one(tx, SQL.markReviewed, [documentId]);
        const reviewedRevision = revision(row.reviewedRevision);
        if (reviewedRevision < 1) throw new Malformed();
        return { status: "ok" as const, reviewedRevision, reviewedAt: instant(row.reviewedAt) };
      }),
    reviewState: (token, documentId) =>
      run(token, async (tx) => {
        const row = await one(tx, SQL.reviewState, [documentId]);
        return {
          status: "ok" as const,
          reviewedRevision: row.reviewedRevision === null ? null : revision(row.reviewedRevision),
          currentRevision: revision(row.currentRevision),
        };
      }),
  };
}
