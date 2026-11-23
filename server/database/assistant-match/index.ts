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
//
// PIL-P1-PODUDARANJE-OBJASNJENJE-SRV (20261214130000): the student owner explains
// a finding once (app.assistant_match_explain; a second explanation is a
// conflict, ZD409), and the findings are read with their explanations
// (app.assistant_match_explanations), null where there is none. While the switch
// is off no explanation is written (not_found) or read.
import { matchSegment, type AssistantAnswer } from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

type Failure = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "conflict" | "unavailable";
};

export type AssistantMatchFound = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly runWords: number;
};
/** The student's explanation of a finding, written once. */
export type AssistantMatchExplanation = { readonly text: string; readonly writtenAt: string };
export type AssistantMatchFinding = AssistantMatchFound & {
  readonly segmentRef: string;
  readonly recordedAt: string;
  readonly attachedAt: string;
  readonly explanation: AssistantMatchExplanation | null;
};
export type AssistantMatchCheckOutcome =
  { readonly status: "ok"; readonly matches: readonly AssistantMatchFound[] } | Failure;
export type AssistantMatchListOutcome =
  { readonly status: "ok"; readonly findings: readonly AssistantMatchFinding[] } | Failure;
export type AssistantMatchExplainOutcome =
  { readonly status: "ok"; readonly explanation: AssistantMatchExplanation } | Failure;

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
  /** The student owner explains one finding (segment and answer), once. */
  explain(
    token: string,
    documentId: string,
    segmentRef: string,
    messageId: string,
    text: string,
  ): Promise<AssistantMatchExplainOutcome>;
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
  if (code === "ZD409") return { status: "conflict" };
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

const keyOf = (segmentRef: string, messageId: string): string =>
  JSON.stringify([segmentRef, messageId]);

function explanationOf(row: Record<string, unknown>): [string, AssistantMatchExplanation] {
  if (typeof row.segmentRef !== "string" || typeof row.text !== "string" || row.text === "") {
    throw new Malformed();
  }
  return [
    keyOf(row.segmentRef, uuid(row.messageId)),
    { text: row.text, writtenAt: instant(row.writtenAt) },
  ];
}

function findingOf(
  row: Record<string, unknown>,
  explanations: ReadonlyMap<string, AssistantMatchExplanation>,
): AssistantMatchFinding {
  const runWords = row.runWords;
  if (
    typeof row.segmentRef !== "string" ||
    typeof runWords !== "number" ||
    !Number.isInteger(runWords) ||
    runWords < 8
  ) {
    throw new Malformed();
  }
  const messageId = uuid(row.messageId);
  return {
    segmentRef: row.segmentRef,
    conversationId: uuid(row.conversationId),
    messageId,
    runWords,
    recordedAt: instant(row.recordedAt),
    attachedAt: instant(row.attachedAt),
    explanation: explanations.get(keyOf(row.segmentRef, messageId)) ?? null,
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
          const explanations = new Map(
            (
              await tx.query<Record<string, unknown>>(
                'SELECT segment_ref AS "segmentRef", message_id AS "messageId", explanation_text AS "text", written_at AS "writtenAt" FROM app.assistant_match_explanations($1)',
                [documentId],
              )
            ).rows.map(explanationOf),
          );
          return { status: "ok", findings: rows.map((row) => findingOf(row, explanations)) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async explain(token, documentId, segmentRef, messageId, text) {
      try {
        return await withActor(token, async (tx): Promise<AssistantMatchExplainOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              'SELECT app.assistant_match_explain($1, $2, $3::uuid, $4) AS "writtenAt"',
              [documentId, segmentRef, messageId, text],
            )
          ).rows;
          if (rows.length !== 1) throw new Malformed();
          return { status: "ok", explanation: { text, writtenAt: instant(rows[0]!.writtenAt) } };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
  };
}
