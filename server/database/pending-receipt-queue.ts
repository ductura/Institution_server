// The worker's read of the pending receipts (DAN-820, VS-1b part 1, 820b-1;
// plan of attack ductura/server#146 S-2, S-3, S-5, S-6). Ductus has the port
// (pending-receipt-signing.ts) and the functions, not an adapter: this is the
// adapter over them. Each read is one statement under the worker's login;
// every row is checked before it leaves this folder, and the answer is the
// port's shape or a closed code, never a partial list or the driver's text.
import type { Pool } from "pg";

import { isEvidenceDomainId } from "../domain/index.ts";

import { count } from "./open-work.ts";
import type {
  PendingBacklogRead,
  PendingBacklogRow,
  PendingReceiptQueue,
  PendingReceiptRow,
  PendingReceiptsRead,
} from "./pending-receipt-signing.ts";

// ISO 8601 in UTC with milliseconds, formatted by the database clock's own value.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const BACKLOG_SQL = `SELECT evidence_domain_id::text AS evidence_domain_id,
       pending_count::text AS pending_count,
       to_char(oldest_created_at AT TIME ZONE 'UTC', ${ISO}) AS oldest_created_at
  FROM app.worker_pending_backlog()`;
const PENDING_SQL = `SELECT receipt_id::text AS receipt_id, receipt_payload
  FROM app.worker_pending_receipts($1::uuid, $2::integer, $3::uuid)`;

/** A receipt id as the database writes a uuid: lowercase, any version. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
/** A real instant written back unchanged; a time that does not parse is false, never a throw. */
function isTime(value: unknown): value is string {
  if (typeof value !== "string" || !TIME.test(value)) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}

type Fail = {
  status: "unavailable";
  reason: "request_invalid" | "row_malformed" | "database_error";
};
const fail = (reason: Fail["reason"]): Fail => ({ status: "unavailable", reason });

/** The rows of an answer, each a plain record of exactly `columns`; null for anything else. */
export function exactRows(
  answer: unknown,
  columns: readonly string[],
): Record<string, unknown>[] | null {
  const list: unknown = (answer as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) return null;
  for (const row of list) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== columns.length || !columns.every((c) => Object.hasOwn(row, c))) return null;
  }
  return list as Record<string, unknown>[];
}

export async function run(
  db: Pick<Pool, "query">,
  text: string,
  values: unknown[],
): Promise<unknown> {
  try {
    return await db.query(text, values);
  } catch {
    // The driver's message can carry the connection string; only the code leaves.
    return undefined;
  }
}

async function backlog(db: Pick<Pool, "query">): Promise<PendingBacklogRead> {
  const answer = await run(db, BACKLOG_SQL, []);
  if (answer === undefined) return fail("database_error");
  const list = exactRows(answer, ["evidence_domain_id", "pending_count", "oldest_created_at"]);
  if (list === null) return fail("row_malformed");
  const out: PendingBacklogRow[] = [];
  for (const row of list) {
    const domain = row.evidence_domain_id;
    const pending = typeof row.pending_count === "string" ? count(row.pending_count) : null;
    const oldest = row.oldest_created_at;
    if (!isEvidenceDomainId(domain) || pending === null || pending < 1 || !isTime(oldest)) {
      return fail("row_malformed");
    }
    if (out.some((r) => r.evidenceDomainId === domain)) return fail("row_malformed");
    out.push({ evidenceDomainId: domain, pendingCount: pending, oldestCreatedAt: oldest });
  }
  return { status: "ok", rows: out };
}

async function pendingReceipts(
  db: Pick<Pool, "query">,
  domain: unknown,
  limit: unknown,
  after: unknown,
): Promise<PendingReceiptsRead> {
  if (
    !isEvidenceDomainId(domain) ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !(after === null || isUuid(after))
  ) {
    return fail("request_invalid");
  }
  const answer = await run(db, PENDING_SQL, [domain, limit, after]);
  if (answer === undefined) return fail("database_error");
  const list = exactRows(answer, ["receipt_id", "receipt_payload"]);
  if (list === null || list.length > limit) return fail("row_malformed");
  const out: PendingReceiptRow[] = [];
  for (const row of list) {
    const id = row.receipt_id;
    const text = row.receipt_payload;
    if (!isUuid(id) || typeof text !== "string" || text === "") return fail("row_malformed");
    if (out.some((r) => r.receiptId === id)) return fail("row_malformed");
    out.push({ receiptId: id, receiptPayloadText: text });
  }
  return { status: "ok", rows: out };
}

/**
 * The read side over a pool of the worker's own login (a member of
 * ductus_worker only); the web process never builds it (D-71, D-102).
 */
export function createPendingReceiptQueue(db: Pick<Pool, "query">): PendingReceiptQueue {
  return {
    backlog: () => backlog(db),
    pendingReceipts: (domain, limit, after) => pendingReceipts(db, domain, limit, after),
  };
}
