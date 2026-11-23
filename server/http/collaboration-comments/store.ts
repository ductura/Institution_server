import type { ActorTransaction } from "../../database/index.ts";
import { verifyDocumentSnapshot } from "../../evidence/index.ts";

const LIST = `SELECT thread_id AS "threadId", comment_id AS "commentId",
  comment_position AS position, author_role AS "authorRole", is_own AS "isOwn",
  body, anchor, state, created_window AS "createdWindow", deleted_window AS "deletedWindow",
  revision FROM collaboration.list_comments($1)`;
// INT-15-SRV: every new thread names a revision (the teacher must, the
// student may); the RPC checks that it exists and that the caller may read it.
const CREATE = "SELECT collaboration.create_revision_comment($1, $2, $3::jsonb, $4) AS id";
export const ACTS = {
  create: { keys: ["documentId", "body", "anchor"], optional: ["revision"] },
  reply: { keys: ["threadId", "body"], sql: "SELECT collaboration.reply_comment($1, $2) AS id" },
  resolve: { keys: ["threadId"], sql: "SELECT collaboration.resolve_thread($1)" },
  reopen: { keys: ["threadId"], sql: "SELECT collaboration.reopen_thread($1)" },
  delete: { keys: ["commentId"], sql: "SELECT collaboration.delete_comment($1)" },
  list: { keys: ["documentId"], sql: LIST },
} as const;
export type Action = keyof typeof ACTS;

type Anchor = {
  nodeId: string;
  quote: string;
  prefix: string;
  suffix: string;
  startHint: number;
  endHint: number;
};
type Answer = { status: 200; body: unknown } | { status: 204 | 409 | 422 | 503 };

async function checkAnchor(
  tx: ActorTransaction,
  documentId: unknown,
  anchor: Anchor,
): Promise<200 | 409 | 422 | 503> {
  const { startHint: start, endHint: end, quote, prefix, suffix } = anchor;
  if (end - start !== quote.length) return 422;
  // This RPC checks the same relationship as create_comment and selects the
  // submitted revision when one exists. It records the teacher's access.
  const { rows } = await tx.query(
    "SELECT outcome, content_hash AS hash, body FROM collaboration.read_live_state($1, NULL)",
    [documentId],
  );
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row?.outcome === "empty") return 409;
  if ((row?.outcome !== "state" && row?.outcome !== "submitted") || typeof row.body !== "string") {
    return 503;
  }
  const snapshot = await verifyDocumentSnapshot(Buffer.from(row.body, "utf8"));
  if (!snapshot.ok || snapshot.sha256 !== row.hash) return 503;
  const node = snapshot.document.nodes.find(({ id }) => id === anchor.nodeId);
  if (node === undefined) return 409;
  const text = node.children.map((child) => child.text).join("");
  // Hints are UTF-16 offsets. For a new comment the selection must still be
  // exact. After storage, clients can relocate the anchor as the text evolves.
  return text.slice(start, end) === quote &&
    text.slice(0, start).endsWith(prefix) &&
    text.startsWith(suffix, end)
    ? 200
    : 409;
}

const iso = (value: unknown) =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;

export async function execute(
  tx: ActorTransaction,
  action: Action,
  input: Record<string, unknown>,
): Promise<Answer> {
  if (action === "create") {
    const { documentId, body, anchor } = input;
    const revision = input.revision ?? null;
    if (anchor !== null) {
      const status = await checkAnchor(tx, documentId, anchor as Anchor);
      if (status !== 200) return { status };
    }
    const { rows } = await tx.query(CREATE, [
      documentId,
      body,
      anchor === null ? null : JSON.stringify(anchor),
      revision,
    ]);
    return { status: 200, body: rows[0] };
  }
  const { keys, sql } = ACTS[action];
  const { rows } = await tx.query(
    sql,
    keys.map((key) => input[key]),
  );
  if (action === "list") {
    const comments = rows.map((row) => ({
      ...row,
      createdWindow: iso(row.createdWindow),
      deletedWindow: iso(row.deletedWindow),
      // bigint arrives as a string; the contract bounds it to a safe integer.
      revision: row.revision === null ? null : Number(row.revision),
    }));
    return { status: 200, body: { comments } };
  }
  return action === "reply" ? { status: 200, body: rows[0] } : { status: 204 };
}
