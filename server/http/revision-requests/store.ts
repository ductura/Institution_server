// The seven actions of POST /api/v1/revision-requests/{action} (DAN-314 2f,
// docs/backend/suradnja.md 4.14), ported from the Ductus boundary of
// server/collaboration/revision-requests.ts: the SQL of each action, which
// keys and which id it takes, and how a row of the SECURITY DEFINER functions
// becomes the answer. The database decides who may, which transition is
// allowed and whether an accepted range changed; this only shapes the call.
import type { ActorTransaction } from "../../database/index.ts";

type Input = Record<string, unknown>;
type Row = Record<string, unknown>;

const TRANSITION = "SELECT outcome, row_seq, version, state FROM ";
const BIGINT = /^(0|[1-9][0-9]{0,15})$/;
const STATES = new Set(["open", "responded", "accepted", "reopened", "withdrawn"]);
const CLOSED = new Set(["accepted", "reopened", "withdrawn"]);
const VERSION_MAX = 1000;

export type Action = "create" | "respond" | "accept" | "reopen" | "rereview" | "withdraw" | "list";

type Spec = {
  /** Exactly these keys, sorted. */
  keys: readonly string[];
  /** The key of the id, checked before the other values (a malformed id reads as a foreign one). */
  id: "documentId" | "requestId";
  sql: string;
  params(input: Input): unknown[];
};

// Each call is spelled out in full: the RPC/HTTP inventory looks for "collaboration.name(".
export const ACTS: Record<Action, Spec> = {
  create: {
    keys: ["anchor", "documentId", "instruction", "requestedRevision"],
    id: "documentId",
    sql:
      "SELECT request_id, row_seq, version, state" +
      " FROM collaboration.create_revision_request($1, $2::jsonb, $3, $4::bigint)",
    params: (i) => [i.documentId, JSON.stringify(i.anchor), i.instruction, i.requestedRevision],
  },
  respond: {
    keys: ["expectedSeq", "explanation", "kind", "requestId", "responseRevision"],
    id: "requestId",
    sql: `${TRANSITION}collaboration.respond_revision_request($1::uuid, $2::bigint, $3, $4, $5::bigint)`,
    params: (i) => [i.requestId, i.expectedSeq, i.kind, i.explanation, i.responseRevision],
  },
  // The hash and the anchor it was computed under travel together (#1831 B);
  // the contract only takes both null or both well formed.
  accept: {
    keys: ["acceptedAnchor", "acceptedRevision", "expectedSeq", "rangeHash", "requestId"],
    id: "requestId",
    sql: `${TRANSITION}collaboration.accept_revision_request($1::uuid, $2::bigint, $3::bigint, $4, $5::jsonb)`,
    params: (i) => [
      i.requestId,
      i.expectedSeq,
      i.acceptedRevision,
      i.rangeHash,
      i.acceptedAnchor === null ? null : JSON.stringify(i.acceptedAnchor),
    ],
  },
  reopen: {
    keys: ["expectedSeq", "instruction", "requestId", "requestedRevision"],
    id: "requestId",
    sql: `${TRANSITION}collaboration.reopen_revision_request($1::uuid, $2::bigint, $3, $4::bigint)`,
    params: (i) => [i.requestId, i.expectedSeq, i.instruction, i.requestedRevision],
  },
  // Only the request and its counter: the database reads the current work
  // itself and decides whether the accepted range changed.
  rereview: {
    keys: ["expectedSeq", "requestId"],
    id: "requestId",
    sql: `${TRANSITION}collaboration.rereview_revision_request($1::uuid, $2::bigint)`,
    params: (i) => [i.requestId, i.expectedSeq],
  },
  withdraw: {
    keys: ["expectedSeq", "requestId"],
    id: "requestId",
    sql: `${TRANSITION}collaboration.withdraw_revision_request($1::uuid, $2::bigint)`,
    params: (i) => [i.requestId, i.expectedSeq],
  },
  list: {
    keys: ["documentId"],
    id: "documentId",
    sql:
      "SELECT request_id, request_state, request_version, request_row_seq, anchor, version, instruction," +
      " requested_revision, opened_is_own, opened_window, response_kind, response_explanation, response_revision," +
      " response_is_own, response_window, closed_as, closed_is_own, closed_window, accepted_revision," +
      " accepted_range_hash FROM collaboration.list_revision_requests($1)",
    params: (i) => [i.documentId],
  },
};

export type Answer = { status: 200 | 409; body: Row } | { status: 503 };

class Malformed extends Error {}

/** A bigint column as node-postgres returns it: a decimal string, read only into a safe integer. */
function bigint(value: unknown, min: number): number | undefined {
  if (typeof value !== "string" || !BIGINT.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

function version(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= VERSION_MAX
    ? (value as number)
    : undefined;
}

const state = (value: unknown) =>
  typeof value === "string" && STATES.has(value) ? value : undefined;
const window = (value: unknown) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const kind = (value: unknown) => (value === "done" || value === "declined" ? value : undefined);
const hash = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
const requestId = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Malformed();
  return value;
}

/** A value, or null where the column may be null; anything else makes the row malformed. */
function nullable<T>(raw: unknown, read: (value: unknown) => T | undefined): T | null {
  return raw === null ? null : must(read(raw));
}

/** Every row has the same keys, for the student and the teacher alike (H4). */
function listRow(row: Row): Row {
  const anchor = row.anchor;
  if (anchor !== null && (typeof anchor !== "object" || Array.isArray(anchor)))
    throw new Malformed();
  const view: Row = {
    request_id: must(requestId(row.request_id)),
    request_state: must(state(row.request_state)),
    request_version: must(version(row.request_version)),
    request_row_seq: must(bigint(row.request_row_seq, 1)),
    anchor,
    version: must(version(row.version)),
    instruction: must(text(row.instruction)),
    requested_revision: must(bigint(row.requested_revision, 0)),
    opened_is_own: must(bool(row.opened_is_own)),
    opened_window: must(window(row.opened_window)),
    response_kind: nullable(row.response_kind, kind),
    response_explanation: nullable(row.response_explanation, text),
    response_revision: nullable(row.response_revision, (v) => bigint(v, 0)),
    response_is_own: nullable(row.response_is_own, bool),
    response_window: nullable(row.response_window, window),
    closed_as: nullable(row.closed_as, (v) =>
      typeof v === "string" && CLOSED.has(v) ? v : undefined,
    ),
    closed_is_own: nullable(row.closed_is_own, bool),
    closed_window: nullable(row.closed_window, window),
    accepted_revision: nullable(row.accepted_revision, (v) => bigint(v, 0)),
    accepted_range_hash: nullable(row.accepted_range_hash, hash),
  };
  // A response and a closing are each whole or absent.
  const groups = [
    [
      "response_kind",
      "response_explanation",
      "response_revision",
      "response_is_own",
      "response_window",
    ],
    ["closed_as", "closed_is_own", "closed_window"],
  ];
  for (const group of groups) {
    if (new Set(group.map((key) => view[key] === null)).size !== 1) throw new Malformed();
  }
  if ((view.accepted_revision !== null) !== (view.closed_as === "accepted")) throw new Malformed();
  if (view.accepted_range_hash !== null && view.closed_as !== "accepted") throw new Malformed();
  return view;
}

function answerOf(action: Action, rows: Row[]): Answer {
  if (action === "list") return { status: 200, body: { requests: rows.map(listRow) } };
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row) throw new Malformed();
  const current = {
    row_seq: must(bigint(row.row_seq, 1)),
    version: must(version(row.version)),
    state: must(state(row.state)),
  };
  if (action === "create") {
    return { status: 200, body: { request_id: must(requestId(row.request_id)), ...current } };
  }
  if (row.outcome === "applied") return { status: 200, body: { outcome: "applied", ...current } };
  // A stale counter is an answer with the current state, not an error.
  if (row.outcome === "conflict") return { status: 409, body: { outcome: "conflict", ...current } };
  throw new Malformed();
}

/** Runs the action under the actor of the session; a row that is not as the contract says is 503. */
export async function execute(tx: ActorTransaction, action: Action, input: Input): Promise<Answer> {
  const spec = ACTS[action];
  const { rows } = await tx.query<Row>(spec.sql, spec.params(input));
  try {
    return answerOf(action, rows);
  } catch (error) {
    if (error instanceof Malformed) return { status: 503 };
    throw error;
  }
}
