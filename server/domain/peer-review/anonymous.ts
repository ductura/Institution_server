// SRV-V19-RECENZIJA-RUTE (Ductus#2055; val 19, docs/contracts/peer-review-v1.md):
// the two answers a student reads in a peer review are anonymous by their shape.
// These functions build them field by field from what the database returns and
// copy nothing else: whatever else a row carries (a person, a work, a task, a
// block id, a mark, a time) never reaches the answer. The database already
// returns only these fields (app.peer_review_work, app.peer_reviews_received);
// this is the second wall, not the first. The text a student wrote about
// themselves in the body of the work is theirs and is not looked for.

/** The kinds of block a reviewer reads; the database turns code into paragraph. */
export const PEER_REVIEW_BLOCK_KINDS = ["paragraph", "heading", "quote", "list_item"] as const;
export type PeerReviewBlockKind = (typeof PEER_REVIEW_BLOCK_KINDS)[number];
export type PeerReviewBlock = { kind: PeerReviewBlockKind; text: string };
export type PeerReviewRubric = { key: string; label: string };

/** One row of app.peer_review_work: a block, or the one row of a work with no block (ord null). */
export type PeerReviewBlockRow = {
  readonly ord: number | null;
  readonly kind: string | null;
  readonly body: string | null;
};

/** One row of app.peer_reviews_received. */
export type PeerReviewReceivedRow = {
  readonly reviewId: string;
  readonly byRubric: unknown;
  readonly general: string | null;
  readonly submittedAt: Date;
};

export type PeerReviewReceived = {
  reviewId: string;
  byRubric: { key: string; label: string; text: string }[];
  general: string | null;
  submittedAt: string;
};

const isKind = (value: unknown): value is PeerReviewBlockKind =>
  (PEER_REVIEW_BLOCK_KINDS as readonly unknown[]).includes(value);

function textOf(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`peer review ${what} is not text`);
  return value;
}

function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`peer review ${what} is not a list`);
  return value;
}

function fieldsOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`peer review ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** The rubrics of a round as {key, label} and nothing else. */
export function anonymousRubrics(value: unknown): PeerReviewRubric[] {
  return listOf(value, "rubrics").map((item) => {
    const rubric = fieldsOf(item, "rubric");
    return { key: textOf(rubric.key, "rubric key"), label: textOf(rubric.label, "rubric label") };
  });
}

/**
 * The blocks of the work in document order, each only its kind and text. A
 * kind outside the four is not passed on under another name: the answer fails
 * (503) rather than show a block the contract does not know.
 */
export function anonymousBlocks(rows: readonly PeerReviewBlockRow[]): PeerReviewBlock[] {
  return rows
    .filter((row) => row.ord !== null)
    .sort((a, b) => a.ord! - b.ord!)
    .map((row) => {
      if (!isKind(row.kind)) throw new Error("unknown peer review block kind");
      return { kind: row.kind, text: textOf(row.body, "block") };
    });
}

/** One received review: its id, the texts by rubric with the label, the general comment and the time. */
export function anonymousReview(row: PeerReviewReceivedRow): PeerReviewReceived {
  if (!(row.submittedAt instanceof Date) || Number.isNaN(row.submittedAt.getTime())) {
    throw new Error("peer review without a time");
  }
  return {
    reviewId: textOf(row.reviewId, "review id"),
    byRubric: listOf(row.byRubric, "review").map((item) => {
      const part = fieldsOf(item, "review part");
      return {
        key: textOf(part.key, "rubric key"),
        label: textOf(part.label, "rubric label"),
        text: textOf(part.text, "review text"),
      };
    }),
    general: row.general === null ? null : textOf(row.general, "general comment"),
    submittedAt: row.submittedAt.toISOString(),
  };
}
