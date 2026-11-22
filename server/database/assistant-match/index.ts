// SRV-1230 (Ductus#2052; P-1, rule 13): the database port of the match of a
// segment with the answers of the assistant (20261213100800). One withActor
// transaction: the RPC hands over the answers of the owner's own conversations
// (none while the switch of the institution is off), the pure comparison of
// server/domain/assistant-match runs in memory, and every match is recorded
// through another RPC, which also attaches the conversation as transferred text.
// Nothing of the segment or of an answer is kept or returned: ids and the
// length of the run only. Every refusal is one not_found (C-23); ZD401 is
// unauthenticated, ZD422 invalid, anything else unavailable; a row of an
// unexpected shape is unavailable too.
import { matchSegment, type AssistantAnswer } from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

type Failure = { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };

export type AssistantMatchFound = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly runWords: number;
};
export type AssistantMatchFinding = AssistantMatchFound & {
  readonly segmentRef: string;
  readonly recordedAt: string;
  readonly attachedAt: string;
};
export type AssistantMatchCheckOutcome =
  { readonly status: "ok"; readonly matches: readonly AssistantMatchFound[] } | Failure;
export type AssistantMatchListOutcome =
  { readonly status: "ok"; readonly findings: readonly AssistantMatchFinding[] } | Failure;

export type AssistantMatch = {
  /** The student owner compares a segment with the answers of the assistant and records each match. */
  check(
    token: string,
    documentId: string,
    segmentRef: string,
    text: string,
  ): Promise<AssistantMatchCheckOutcome>;
  /** The findings of a work: the same for the owner and the readers; none while the switch is off. */
  list(token: string, documentId: string): Promise<AssistantMatchListOutcome>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Malformed extends Error {}

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(thrown: unknown): Failure {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Malformed();
  return value;
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) throw new Malformed();
  return date.toISOString();
}

function answerOf(row: Record<string, unknown>): AssistantAnswer {
  if (typeof row.content !== "string") throw new Malformed();
  return { id: uuid(row.messageId), conversationId: uuid(row.conversationId), text: row.content };
}

function findingOf(row: Record<string, unknown>): AssistantMatchFinding {
  const runWords = row.runWords;
  if (
    typeof row.segmentRef !== "string" ||
    typeof runWords !== "number" ||
    !Number.isInteger(runWords) ||
    runWords < 8
  ) {
    throw new Malformed();
  }
  return {
    segmentRef: row.segmentRef,
    conversationId: uuid(row.conversationId),
    messageId: uuid(row.messageId),
    runWords,
    recordedAt: instant(row.recordedAt),
    attachedAt: instant(row.attachedAt),
  };
}

export function createAssistantMatch(withActor: WithActor): AssistantMatch {
  return {
    async check(token, documentId, segmentRef, text) {
      try {
        return await withActor(token, async (tx): Promise<AssistantMatchCheckOutcome> => {
          const answers = (
            await tx.query<Record<string, unknown>>(
              'SELECT conversation_id AS "conversationId", message_id AS "messageId", content FROM app.assistant_match_responses($1)',
              [documentId],
            )
          ).rows.map(answerOf);
          const matches = matchSegment(text, answers);
          for (const match of matches) {
            await tx.query("SELECT app.assistant_match_record($1, $2, $3::uuid, $4) AS recorded", [
              documentId,
              segmentRef,
              match.messageId,
              match.runWords,
            ]);
          }
          return { status: "ok", matches };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async list(token, documentId) {
      try {
        return await withActor(token, async (tx): Promise<AssistantMatchListOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              'SELECT segment_ref AS "segmentRef", conversation_id AS "conversationId", message_id AS "messageId", run_words AS "runWords", recorded_at AS "recordedAt", attached_at AS "attachedAt" FROM app.assistant_match_read($1)',
              [documentId],
            )
          ).rows;
          return { status: "ok", findings: rows.map(findingOf) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
  };
}
