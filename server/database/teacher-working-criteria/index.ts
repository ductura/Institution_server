// SRV-1107 (Ductus#2051): the database port of the teacher's working criteria
// (20261121150000). Each call is one withActor transaction over one RPC of
// schema collaboration; the RPCs decide who may (a teacher of the work, and
// only the author reads the rows as a teacher). Since Daniel's decision of
// 26. 11. 2026 (Ductus#2058 c.7192734757, replacing B-9) the student who owns
// the work reads every teacher's criteria too, each teacher separately
// (20261220200000). The answer is a closed
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
  /** The owner student's read: each teacher's six criteria, never merged. */
  forStudent(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly teachers: readonly TeacherCriteria[] } | Refusal>;
};

export type TeacherCriteria = {
  readonly teacherId: string;
  readonly teacherName: { readonly givenName: string; readonly familyName: string } | null;
  readonly criteria: readonly WorkingCriterion[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SQL = {
  list: "SELECT criterion_id AS id, assessment, note FROM collaboration.list_working_criteria($1)",
  forStudent:
    "SELECT teacher_id, given_name, family_name, criterion_id AS id, assessment, note FROM collaboration.student_working_criteria($1)",
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

/** Six criteria in the fixed order, or the answer is unavailable. */
function inOrder(criteria: readonly WorkingCriterion[]): readonly WorkingCriterion[] {
  const ordered = WORKING_CRITERIA.every((known, index) => criteria[index]?.id === known.id);
  if (criteria.length !== WORKING_CRITERIA.length || !ordered) throw new Malformed();
  return criteria;
}

/** Consecutive rows of one teacher form one entry; a teacher seen twice is malformed. */
function byTeacher(rows: readonly Record<string, unknown>[]): TeacherCriteria[] {
  const teachers: TeacherCriteria[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index]!;
    const teacherId = first.teacher_id;
    if (typeof teacherId !== "string" || !UUID.test(teacherId)) throw new Malformed();
    if (teachers.some((teacher) => teacher.teacherId === teacherId)) throw new Malformed();
    const { given_name: given, family_name: family } = first;
    if ((given === null) !== (family === null)) throw new Malformed();
    if (given !== null && (typeof given !== "string" || typeof family !== "string")) {
      throw new Malformed();
    }
    const own = rows.slice(index, index + WORKING_CRITERIA.length);
    if (
      own.some(
        (row) =>
          row.teacher_id !== teacherId || row.given_name !== given || row.family_name !== family,
      )
    ) {
      throw new Malformed();
    }
    teachers.push({
      teacherId,
      teacherName: given === null ? null : { givenName: given, familyName: family as string },
      criteria: inOrder(own.map(toCriterion)),
    });
    index += WORKING_CRITERIA.length;
  }
  return teachers;
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
        const criteria = inOrder((await rowsOf(tx, SQL.list, [documentId])).map(toCriterion));
        return { status: "ok" as const, criteria };
      }),
    forStudent: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        teachers: byTeacher(await rowsOf(tx, SQL.forStudent, [documentId])),
      })),
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
