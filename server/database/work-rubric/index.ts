// SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17): the database port of the teacher's marks of a level
// per criterion of an assignment's rubric (20261219270000). Each call is one withActor
// transaction over one RPC of schema collaboration; the RPCs decide who may (a teacher of the
// work, and only the author reads the rows). The answer is a closed status, never a database
// message or SQLSTATE: ZD401 is unauthenticated, ZD403 not_found (one answer for "not yours",
// "not there", "no relation" and "no such criterion in the latest rubric version", C-23), ZD422
// invalid, anything else unavailable. A row of an unexpected shape is unavailable too. Nothing
// here reads or writes the work, and no number is computed from a level.
import type { ActorTransaction, WithActor } from "../index.ts";

export type WorkRubricLevel = 0 | 1 | 2;

export type WorkRubricMark = {
  readonly criterionId: string;
  readonly level: WorkRubricLevel | null;
  readonly note: string | null;
};

export type WorkRubricMarks = {
  readonly rubricVersion: number;
  readonly marks: readonly WorkRubricMark[];
};

export type WorkRubricRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};

export type WorkRubricStore = {
  list(
    token: string,
    documentId: string,
  ): Promise<({ readonly status: "ok" } & WorkRubricMarks) | WorkRubricRefusal>;
  save(
    token: string,
    documentId: string,
    criterionId: string,
    level: WorkRubricLevel | null,
    note: string | null,
  ): Promise<{ readonly status: "saved"; readonly mark: WorkRubricMark } | WorkRubricRefusal>;
};

const SQL = {
  list: "SELECT rubric_version AS version, criterion_id AS id, level, note FROM collaboration.list_work_rubric($1)",
  save: "SELECT rubric_version AS version, criterion_id AS id, level, note FROM collaboration.save_work_rubric_mark($1, $2, $3::smallint, $4)",
} as const;

const CRITERION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

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

function refusal(thrown: unknown): WorkRubricRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

type Row = { version: number; mark: WorkRubricMark };

function toRow(row: Record<string, unknown>): Row {
  const { version, id: criterionId, level, note } = row;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Malformed();
  }
  if (typeof criterionId !== "string" || !CRITERION_ID.test(criterionId)) throw new Malformed();
  if (level !== null && level !== 0 && level !== 1 && level !== 2) throw new Malformed();
  if (note !== null && typeof note !== "string") throw new Malformed();
  return { version, mark: { criterionId, level, note } };
}

export function createWorkRubric(withActor: WithActor): WorkRubricStore {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | WorkRubricRefusal> {
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
        const rows = (await rowsOf(tx, SQL.list, [documentId])).map(toRow);
        const first = rows[0];
        if (first === undefined) throw new Malformed();
        if (rows.some((row) => row.version !== first.version)) throw new Malformed();
        const ids = rows.map((row) => row.mark.criterionId);
        if (new Set(ids).size !== ids.length) throw new Malformed();
        return {
          status: "ok" as const,
          rubricVersion: first.version,
          marks: rows.map((row) => row.mark),
        };
      }),
    save: (token, documentId, criterionId, level, note) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.save, [documentId, criterionId, level, note]);
        if (rows.length !== 1) throw new Malformed();
        const { mark } = toRow(rows[0]!);
        if (mark.criterionId !== criterionId) throw new Malformed();
        return { status: "saved" as const, mark };
      }),
  };
}
