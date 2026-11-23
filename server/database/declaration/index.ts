// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
// OD-15, section 6.7): migration 20261214110000.
//
// The gate: the declaration a submission requires, read before the request
// (declaration.submission_gate). While the assignment of the caller's
// document requires a declaration and none is confirmed for the submitted
// revision, the answer is declaration_required; otherwise proceed, also for
// anything app.request_submission answers itself. The triggers that pin the
// declaration to the request and refuse the record without it stay the
// guarantee (ZD428, mapped by submitWork). Any other answer is an error, so a
// failed read never lets a submission through (PRODUCT §5 rule 11).
//
// The switch: the teacher of the assignment reads and sets whether it
// requires the declaration (institution.declaration_required_setting,
// institution.set_declaration_required). Refusals are outcomes, never
// thrown: ZD401 unauthorized, ZD403 not_found (one answer for every refusal,
// C-23), ZD422 invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

export type SubmissionDeclarationGateAnswer = "proceed" | "declaration_required";

export type SubmissionDeclarationGate = (
  token: string,
  input: { readonly documentId: string; readonly revision: number },
) => Promise<SubmissionDeclarationGateAnswer>;

const SQL = "SELECT declaration.submission_gate($1, $2) AS gate";

export function createSubmissionDeclarationGate(withActor: WithActor): SubmissionDeclarationGate {
  return (token, input) =>
    withActor(token, async (tx) => {
      const { rows } = await tx.query<{ gate: unknown }>(SQL, [input.documentId, input.revision]);
      const gate = rows.length === 1 ? rows[0]?.gate : undefined;
      if (gate === "proceed" || gate === "declaration_required") return gate;
      throw new Error("Invalid submission gate response");
    });
}

export type DeclarationRequiredSetting =
  | { readonly status: "read"; readonly required: boolean; readonly changedAt: string | null }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

export type DeclarationRequiredSwitch = {
  /** The switch of the assignment, for its teacher. */
  read(token: string, assignmentId: string): Promise<DeclarationRequiredSetting>;
  /** The teacher of the assignment sets it; the value in force again changes nothing. */
  set(token: string, assignmentId: string, required: boolean): Promise<DeclarationRequiredSetting>;
};

const READ_SQL = `SELECT required, changed_at AS "changedAt"
  FROM institution.declaration_required_setting($1::uuid)`;
const SET_SQL = `SELECT required, changed_at AS "changedAt"
  FROM institution.set_declaration_required($1::uuid, $2::boolean)`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Row = { required?: unknown; changedAt?: unknown };

function settingOf(rows: readonly Row[]): { required: boolean; changedAt: string | null } {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined || typeof row.required !== "boolean") {
    throw new Error("Invalid declaration switch response");
  }
  const at = row.changedAt;
  if (at === null) return { required: row.required, changedAt: null };
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new Error("Invalid declaration switch response");
  }
  return { required: row.required, changedAt: at.toISOString() };
}

function refusalOf(error: unknown): DeclarationRequiredSetting | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid_input" };
  return undefined;
}

export function createDeclarationRequiredSwitch(withActor: WithActor): DeclarationRequiredSwitch {
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
    async set(token, assignmentId, required) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      if (typeof required !== "boolean") return { status: "invalid_input" };
      try {
        return await withActor(token, async (tx) => {
          const setting = settingOf((await tx.query<Row>(SET_SQL, [assignmentId, required])).rows);
          // Confirmed inside the transaction, so another answer rolls the write back.
          if (setting.required !== required) throw new Error("Unconfirmed declaration switch");
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

export {
  createDeclarationQuestionPort,
  type DeclarationQuestionPort,
  type DeclarationQuestionSetting,
} from "./question.ts";
