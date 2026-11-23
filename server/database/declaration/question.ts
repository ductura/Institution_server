// SRV-IZJAVA-PITANJE (owner decision of 23. 11. 2026, NF-5 question 3;
// declaration-v1 section 6.8): migration 20261214150000.
//
// The teacher of the assignment (course teacher or mentor) reads and sets the
// one optional question asked with the declaration
// (institution.declaration_question_setting, set_declaration_question). Every
// change is recorded with its author and time in the database. Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD422 invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

export type DeclarationQuestionSetting =
  | { readonly status: "read"; readonly question: string | null; readonly changedAt: string | null }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

export type DeclarationQuestionPort = {
  /** The question of the assignment, for its teacher. */
  read(token: string, assignmentId: string): Promise<DeclarationQuestionSetting>;
  /** The teacher of the assignment sets it (null removes it); the question in force again changes nothing. */
  set(
    token: string,
    assignmentId: string,
    question: string | null,
  ): Promise<DeclarationQuestionSetting>;
};

const READ_SQL = `SELECT question_text AS "question", changed_at AS "changedAt"
  FROM institution.declaration_question_setting($1::uuid)`;
const SET_SQL = `SELECT question_text AS "question", changed_at AS "changedAt"
  FROM institution.set_declaration_question($1::uuid, $2::text)`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Row = { question?: unknown; changedAt?: unknown };

function settingOf(rows: readonly Row[]): { question: string | null; changedAt: string | null } {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined || (row.question !== null && typeof row.question !== "string")) {
    throw new Error("Invalid declaration question response");
  }
  const at = row.changedAt;
  if (at === null) return { question: row.question, changedAt: null };
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new Error("Invalid declaration question response");
  }
  return { question: row.question, changedAt: at.toISOString() };
}

function refusalOf(error: unknown): DeclarationQuestionSetting | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid_input" };
  return undefined;
}

export function createDeclarationQuestionPort(withActor: WithActor): DeclarationQuestionPort {
  return {
    async read(token, assignmentId) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => ({
          status: "read" as const,
          ...settingOf((await tx.query<Row>(READ_SQL, [assignmentId])).rows),
        }));
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    async set(token, assignmentId, question) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      if (question !== null && typeof question !== "string") return { status: "invalid_input" };
      try {
        return await withActor(token, async (tx) => {
          const setting = settingOf((await tx.query<Row>(SET_SQL, [assignmentId, question])).rows);
          // Confirmed inside the transaction, so another answer rolls the write back.
          if (setting.question !== question) throw new Error("Unconfirmed declaration question");
          return { status: "read" as const, ...setting };
        });
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}
