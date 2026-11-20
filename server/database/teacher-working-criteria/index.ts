// SRV-1107 (Ductus#2051, B-9): the database port of the teacher's private
// working criteria (20261121105000). Each call is one withActor transaction
// over one RPC of schema collaboration; the RPCs decide who may (a teacher of
// the work, and only the author reads the rows). The answer is a closed
// status, never a database message or SQLSTATE: ZD401 is unauthenticated,
// ZD403 not_found (one answer for "not yours", "not there" and "no relation",
// C-23), ZD422 invalid, anything else unavailable. A row of an unexpected shape
// is unavailable too. Nothing here reads or writes the work, and no number is
// computed from an assessment.
import type { ActorTransaction, WithActor } from "../index.ts";

/**
 * The six criteria of the prototype (S.rubric) in their fixed order. The label is
 * a message key, never a sentence (docs/CODE_STYLE.md §8): the text is in
 * locales/hr.json under `workingCriteria`.
 */
export const WORKING_CRITERIA = [
  { id: "topic", label: "workingCriteria.topic" },
  { id: "structure", label: "workingCriteria.structure" },
  { id: "sources", label: "workingCriteria.sources" },
  { id: "method", label: "workingCriteria.method" },
  { id: "language", label: "workingCriteria.language" },
  { id: "formatting", label: "workingCriteria.formatting" },
] as const;
export type WorkingCriterionId = (typeof WORKING_CRITERIA)[number]["id"];
export type Assessment = 0 | 1 | 2;

export type WorkingCriterion = {
  readonly id: WorkingCriterionId;
  readonly label: string;
  readonly assessment: Assessment | null;
  readonly note: string | null;
};

export type Refusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};

export type TeacherWorkingCriteria = {
  list(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly criteria: readonly WorkingCriterion[] } | Refusal>;
  save(
    token: string,
    documentId: string,
    criterionId: WorkingCriterionId,
    assessment: Assessment | null,
    note: string | null,
  ): Promise<{ readonly status: "saved"; readonly criterion: WorkingCriterion } | Refusal>;
};

const SQL = {
  list: "SELECT criterion_id AS id, assessment, note FROM collaboration.list_working_criteria($1)",
  save: "SELECT criterion_id AS id, assessment, note FROM collaboration.save_working_criterion($1, $2, $3::smallint, $4)",
} as const;

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

function refusal(thrown: unknown): Refusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function toCriterion(row: Record<string, unknown>): WorkingCriterion {
  const known = WORKING_CRITERIA.find((criterion) => criterion.id === row.id);
  if (known === undefined) throw new Malformed();
  const { assessment, note } = row;
  if (assessment !== null && assessment !== 0 && assessment !== 1 && assessment !== 2) {
    throw new Malformed();
  }
  if (note !== null && typeof note !== "string") throw new Malformed();
  return { id: known.id, label: known.label, assessment, note };
}

export function createTeacherWorkingCriteria(withActor: WithActor): TeacherWorkingCriteria {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | Refusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;

  return {
    list: (token, documentId) =>
      run(token, async (tx) => {
        const criteria = (await rowsOf(tx, SQL.list, [documentId])).map(toCriterion);
        const inOrder = WORKING_CRITERIA.every((known, index) => criteria[index]?.id === known.id);
        if (criteria.length !== WORKING_CRITERIA.length || !inOrder) throw new Malformed();
        return { status: "ok" as const, criteria };
      }),
    save: (token, documentId, criterionId, assessment, note) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.save, [documentId, criterionId, assessment, note]);
        if (rows.length !== 1) throw new Malformed();
        const criterion = toCriterion(rows[0]!);
        if (criterion.id !== criterionId) throw new Malformed();
        return { status: "saved" as const, criterion };
      }),
  };
}
