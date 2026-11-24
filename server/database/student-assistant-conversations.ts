// SRV-ASIST-CITANJE (Ductus#2055 c.7142266537): the caller's own assistant
// conversations of one assignment, for student.assistant-conversations.get.
// One withActor transaction under RLS: the web role reads assistant.conversation
// and assistant.request through their student read policies (the row's own
// student, 20261122100000), and the query asks for the session's student
// again, so the list is never anyone else's. The caller must be a student of
// the assignment (its course or its open mentorship), asked through
// actor_assignment_ids('{student}') as student.notice.get does: another's
// assignment, an unknown one and an ended relation read NOT_FOUND alike
// (C-23). No message text is read. A row the port cannot vouch for is
// ROW_MALFORMED, never a partial answer. Writes nothing.
import type { AppError, Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

export const STUDENT_CONVERSATIONS_UNAUTHENTICATED = error(
  "STUDENT_CONVERSATIONS_UNAUTHENTICATED",
  "studentConversations.unauthenticated",
);
export const STUDENT_CONVERSATIONS_NOT_FOUND = error(
  "STUDENT_CONVERSATIONS_NOT_FOUND",
  "studentConversations.not_found",
);
export const STUDENT_CONVERSATIONS_ROW_MALFORMED = error(
  "STUDENT_CONVERSATIONS_ROW_MALFORMED",
  "studentConversations.row_malformed",
);
export const STUDENT_CONVERSATIONS_DATABASE_ERROR = error(
  "STUDENT_CONVERSATIONS_DATABASE_ERROR",
  "studentConversations.database_error",
);

/** One conversation as the list shows it; instants as Date.toISOString writes them. */
export type ConversationSummary = {
  conversationId: string;
  purposeKey: string;
  createdAt: string;
  requestCount: number;
  lastActivityAt: string;
};

export type StudentConversationsReader = {
  read(token: string | undefined, assignmentId: string): Promise<Result<ConversationSummary[]>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSE = /^[a-z][a-z0-9_]{0,63}$/;
const INT_MAX = 2_147_483_647;

const ACTOR_SQL = "SELECT app.current_user_id() AS user_id";
const STUDENT_SQL = `SELECT $1::uuid = ANY ((SELECT institution.actor_assignment_ids('{student}'))::uuid[]) AS student`;
// The purpose is the first request's: begin_request creates a conversation only
// together with a request that is not refused, so there is always one.
const LIST_SQL = `SELECT c.id AS conversation_id, c.created_at,
    (SELECT q.purpose_key FROM assistant.request q
      WHERE q.conversation_id = c.id ORDER BY q.requested_at, q.id LIMIT 1) AS purpose_key,
    (SELECT count(*) FROM assistant.request q WHERE q.conversation_id = c.id)::integer AS request_count,
    greatest(c.created_at, (SELECT max(coalesce(q.finished_at, q.sent_at, q.requested_at))
      FROM assistant.request q WHERE q.conversation_id = c.id)) AS last_activity_at
  FROM assistant.conversation c
  WHERE c.assignment_id = $1::uuid AND c.student_id = (SELECT app.current_user_id())
  ORDER BY last_activity_at DESC, c.id`;

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });
const own = (row: object, key: string): unknown =>
  Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

const instant = (value: unknown): string | undefined =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;

/** The rows as summaries, or null when any part of any row does not check. */
export function conversationsOf(rows: unknown): ConversationSummary[] | null {
  if (!Array.isArray(rows)) return null;
  const out: ConversationSummary[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const conversationId = own(row, "conversation_id");
    const purposeKey = own(row, "purpose_key");
    const requestCount = own(row, "request_count");
    const createdAt = instant(own(row, "created_at"));
    const lastActivityAt = instant(own(row, "last_activity_at"));
    if (
      typeof conversationId !== "string" ||
      !UUID.test(conversationId) ||
      typeof purposeKey !== "string" ||
      !PURPOSE.test(purposeKey) ||
      !Number.isInteger(requestCount) ||
      (requestCount as number) < 1 ||
      (requestCount as number) > INT_MAX ||
      createdAt === undefined ||
      lastActivityAt === undefined ||
      lastActivityAt < createdAt
    ) {
      return null;
    }
    out.push({
      conversationId,
      purposeKey,
      createdAt,
      requestCount: requestCount as number,
      lastActivityAt,
    });
  }
  return out;
}

export function createStudentConversationsReader(withActor: WithActor): StudentConversationsReader {
  return {
    async read(token, assignmentId) {
      if (token === undefined || !TOKEN.test(token))
        return fail(STUDENT_CONVERSATIONS_UNAUTHENTICATED);
      if (!UUID.test(assignmentId)) return fail(STUDENT_CONVERSATIONS_NOT_FOUND);
      let answer: { actor: unknown; student: unknown; rows: unknown };
      try {
        answer = await withActor(token, async (tx) => {
          const actor = (await tx.query(ACTOR_SQL, [])).rows;
          const student = (await tx.query(STUDENT_SQL, [assignmentId])).rows;
          const rows = (await tx.query(LIST_SQL, [assignmentId])).rows;
          return { actor, student, rows };
        });
      } catch (thrown) {
        return fail(
          codeOf(thrown) === "ZD401"
            ? STUDENT_CONVERSATIONS_UNAUTHENTICATED
            : STUDENT_CONVERSATIONS_DATABASE_ERROR,
        );
      }
      const one = (rows: unknown, key: string): unknown =>
        Array.isArray(rows) && rows.length === 1 && typeof rows[0] === "object" && rows[0] !== null
          ? own(rows[0] as object, key)
          : undefined;
      const actor = one(answer.actor, "user_id");
      if (actor === null || actor === undefined) return fail(STUDENT_CONVERSATIONS_UNAUTHENTICATED);
      const student = one(answer.student, "student");
      if (student === false || student === null) return fail(STUDENT_CONVERSATIONS_NOT_FOUND);
      if (student !== true) return fail(STUDENT_CONVERSATIONS_ROW_MALFORMED);
      const list = conversationsOf(answer.rows);
      return list === null ? fail(STUDENT_CONVERSATIONS_ROW_MALFORMED) : { ok: true, value: list };
    },
  };
}
