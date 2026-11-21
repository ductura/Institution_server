// SRV-1203 (Val 12 / M9.0-S2, Ductus#2052): the database port of the AI
// assistant requests, step 3 of Ductus docs/contracts/ai-request-v1.md
// (migration 20261122110000). Each call is one withActor transaction over one
// RPC of schema assistant; the database decides ownership, policy, the cost
// configuration and the budget, and every amount, limit and student comes
// from it or from the session, never from here (T3, M5). The route (step 4)
// calls the port of the provider only after markSent answered "sent" (R2).
//
// The answer is a closed status, never a database message or SQLSTATE: ZD401
// unauthenticated, ZD403 forbidden (one answer for "not yours" and "not
// there", M4), ZD409 idempotency_conflict for begin and conflict elsewhere,
// ZD422 invalid, anything else unavailable. A row of an unexpected shape is
// unavailable too. Amounts are bigint micro-euros, sent as decimal strings.
import type { ActorTransaction, WithActor } from "../index.ts";

export const ASSISTANT_REQUEST_STATES = Object.freeze([
  "rejected",
  "reserved",
  "sent",
  "completed",
  "provider_failed",
  "outcome_unknown",
  "settled",
] as const);
export type AssistantRequestState = (typeof ASSISTANT_REQUEST_STATES)[number];

/** The reasons a request row carries (contract, "Ishodi"); only for rejected and provider_failed. */
export type AssistantRejectReason =
  | "forbidden"
  | "ai_disabled"
  | "purpose_not_allowed"
  | "budget_exceeded"
  | "request_outcome_unknown"
  | "provider_failed";

export type AssistantRefusal = {
  readonly status:
    | "unauthenticated"
    | "forbidden"
    | "invalid"
    | "idempotency_conflict"
    | "conflict"
    | "unavailable";
};

export type BeginRequestInput = {
  readonly idempotencyKey: string;
  readonly assignmentId: string;
  readonly conversationId: string | null;
  readonly purposeCatalogVersion: number;
  readonly purposeKey: string;
  /** NFC, as the route admitted it (Z9, Z10). */
  readonly paragraph: string;
  /** From the versioned configuration in config/faculties, never from the client. */
  readonly providerId: string;
  readonly modelId: string;
  readonly configVersion: string;
};

export type BegunRequest = {
  readonly status: "ok";
  readonly requestId: string;
  readonly conversationId: string | null;
  readonly state: AssistantRequestState;
  readonly reason: AssistantRejectReason | null;
  /** True when the key was already used for the same request (R4). */
  readonly replayed: boolean;
  /** Only for a replay of a completed request. */
  readonly response: { readonly id: string; readonly text: string } | null;
};

export type AssistantMessage = {
  readonly seq: number;
  readonly id: string;
  readonly requestId: string;
  readonly role: "student_paragraph" | "provider_response";
  readonly content: string;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly requestState: AssistantRequestState;
};

export type CostConfigInput = {
  /** The version the administrator saw as the latest; 0 when there is none. */
  readonly expectedVersion: number;
  /** null turns the limit, and so the assistant, off (P1). */
  readonly studentDayMicro: bigint | null;
  readonly studentAssignmentDayMicro: bigint | null;
  readonly reserveMicro: bigint | null;
};

export type AssistantRequests = {
  begin(token: string, input: BeginRequestInput): Promise<BegunRequest | AssistantRefusal>;
  markSent(
    token: string,
    requestId: string,
  ): Promise<
    | {
        readonly status: "ok";
        readonly state: "sent" | "rejected";
        readonly reason: AssistantRejectReason | null;
      }
    | AssistantRefusal
  >;
  complete(
    token: string,
    requestId: string,
    response: string,
    actualMicro: bigint,
  ): Promise<
    | {
        readonly status: "ok";
        readonly state: AssistantRequestState;
        /** False for a response after outcome_unknown: dropped (R7). */
        readonly accepted: boolean;
        readonly responseId: string | null;
      }
    | AssistantRefusal
  >;
  fail(
    token: string,
    requestId: string,
    actualMicro: bigint | null,
  ): Promise<
    | { readonly status: "ok"; readonly state: AssistantRequestState; readonly accepted: boolean }
    | AssistantRefusal
  >;
  markOutcomeUnknown(
    token: string,
    requestId: string,
  ): Promise<{ readonly status: "ok"; readonly state: AssistantRequestState } | AssistantRefusal>;
  readConversation(
    token: string,
    conversationId: string,
  ): Promise<
    { readonly status: "ok"; readonly messages: readonly AssistantMessage[] } | AssistantRefusal
  >;
  publishCostConfig(
    token: string,
    input: CostConfigInput,
  ): Promise<
    | { readonly status: "published" | "limit_above_cap"; readonly version: number }
    | AssistantRefusal
  >;
};

const SQL = {
  begin:
    'SELECT request_id AS "requestId", conversation_id AS "conversationId", state, reason, replayed, response_id AS "responseId", response FROM assistant.begin_request($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  markSent: "SELECT state, reason FROM assistant.mark_sent($1)",
  complete:
    'SELECT state, accepted, response_id AS "responseId" FROM assistant.complete_request($1, $2, $3::bigint)',
  fail: "SELECT state, accepted FROM assistant.fail_request($1, 'provider_failed', $2::bigint)",
  markOutcomeUnknown: "SELECT assistant.mark_outcome_unknown($1) AS state",
  read: 'SELECT seq, message_id AS id, request_id AS "requestId", role, content, content_sha256 AS "contentSha256", created_at AS "createdAt", request_state AS "requestState" FROM assistant.read_conversation($1)',
  publish:
    "SELECT outcome, version_no AS version FROM assistant.publish_cost_config($1, $2::bigint, $3::bigint, $4::bigint)",
} as const;

const REASONS: readonly string[] = [
  "forbidden",
  "ai_disabled",
  "purpose_not_allowed",
  "budget_exceeded",
  "request_outcome_unknown",
  "provider_failed",
];

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown, conflict: AssistantRefusal["status"]): AssistantRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "forbidden" };
  if (code === "ZD409") return { status: conflict };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

const isState = (value: unknown): value is AssistantRequestState =>
  typeof value === "string" && (ASSISTANT_REQUEST_STATES as readonly string[]).includes(value);
const isReason = (value: unknown): value is AssistantRejectReason | null =>
  value === null || (typeof value === "string" && REASONS.includes(value));
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function state(value: unknown): AssistantRequestState {
  if (!isState(value)) throw new Malformed();
  return value;
}
function reason(value: unknown): AssistantRejectReason | null {
  if (!isReason(value)) throw new Malformed();
  return value;
}
function only(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length !== 1) throw new Malformed();
  return rows[0]!;
}
const micro = (value: bigint | null) => (value === null ? null : value.toString());

function toMessage(row: Record<string, unknown>): AssistantMessage {
  const { seq, id, requestId, role, content, contentSha256, createdAt, requestState } = row;
  if (
    typeof seq !== "number" ||
    !isId(id) ||
    !isId(requestId) ||
    (role !== "student_paragraph" && role !== "provider_response") ||
    typeof content !== "string" ||
    typeof contentSha256 !== "string" ||
    !(createdAt instanceof Date) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new Malformed();
  }
  return {
    seq,
    id,
    requestId,
    role,
    content,
    contentSha256,
    createdAt: createdAt.toISOString(),
    requestState: state(requestState),
  };
}

export function createAssistantRequests(withActor: WithActor): AssistantRequests {
  async function run<T>(
    token: string,
    conflict: AssistantRefusal["status"],
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | AssistantRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown, conflict);
    }
  }
  const one = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    only((await tx.query<Record<string, unknown>>(sql, params)).rows);

  return {
    begin: (token, input) =>
      run(token, "idempotency_conflict", async (tx) => {
        const row = await one(tx, SQL.begin, [
          input.idempotencyKey,
          input.assignmentId,
          input.conversationId,
          input.purposeCatalogVersion,
          input.purposeKey,
          input.paragraph,
          input.providerId,
          input.modelId,
          input.configVersion,
        ]);
        const { requestId, conversationId, replayed, responseId, response } = row;
        if (
          !isId(requestId) ||
          (conversationId !== null && !isId(conversationId)) ||
          typeof replayed !== "boolean" ||
          (responseId !== null && !isId(responseId)) ||
          (response !== null && typeof response !== "string")
        ) {
          throw new Malformed();
        }
        return {
          status: "ok" as const,
          requestId,
          conversationId,
          state: state(row["state"]),
          reason: reason(row["reason"]),
          replayed,
          response:
            isId(responseId) && typeof response === "string"
              ? { id: responseId, text: response }
              : null,
        };
      }),
    markSent: (token, requestId) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, SQL.markSent, [requestId]);
        const next = state(row["state"]);
        if (next !== "sent" && next !== "rejected") throw new Malformed();
        return { status: "ok" as const, state: next, reason: reason(row["reason"]) };
      }),
    complete: (token, requestId, response, actualMicro) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, SQL.complete, [requestId, response, micro(actualMicro)]);
        const { accepted, responseId } = row;
        if (typeof accepted !== "boolean" || (responseId !== null && !isId(responseId)))
          throw new Malformed();
        return { status: "ok" as const, state: state(row["state"]), accepted, responseId };
      }),
    fail: (token, requestId, actualMicro) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, SQL.fail, [requestId, micro(actualMicro)]);
        if (typeof row["accepted"] !== "boolean") throw new Malformed();
        return { status: "ok" as const, state: state(row["state"]), accepted: row["accepted"] };
      }),
    markOutcomeUnknown: (token, requestId) =>
      run(token, "conflict", async (tx) => ({
        status: "ok" as const,
        state: state((await one(tx, SQL.markOutcomeUnknown, [requestId]))["state"]),
      })),
    readConversation: (token, conversationId) =>
      run(token, "conflict", async (tx) => ({
        status: "ok" as const,
        messages: (await tx.query<Record<string, unknown>>(SQL.read, [conversationId])).rows.map(
          toMessage,
        ),
      })),
    publishCostConfig: (token, input) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, SQL.publish, [
          input.expectedVersion,
          micro(input.studentDayMicro),
          micro(input.studentAssignmentDayMicro),
          micro(input.reserveMicro),
        ]);
        const { outcome, version } = row;
        if (
          (outcome !== "published" && outcome !== "limit_above_cap") ||
          typeof version !== "number"
        ) {
          throw new Malformed();
        }
        return { status: outcome, version };
      }),
  };
}

/** What the worker's connection offers: one statement, as ductus_worker. */
export type WorkerQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * The worker's sweep of one request (M10: the job carries only its id). The
 * answer is the state after the call, or forbidden for an id that does not
 * exist; a second call changes nothing.
 */
export async function sweepAndSettle(
  query: WorkerQuery,
  requestId: string,
): Promise<{ readonly status: "ok"; readonly state: AssistantRequestState } | AssistantRefusal> {
  try {
    const row = only(
      (await query("SELECT assistant.sweep_and_settle($1) AS state", [requestId])).rows,
    );
    return { status: "ok", state: state(row["state"]) };
  } catch (thrown) {
    return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown, "conflict");
  }
}
