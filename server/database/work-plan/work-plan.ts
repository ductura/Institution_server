// SRV-F4-PM2-R15 (Ductus#2059; plan M5.14b, D-234): the database port of the plan
// of a work (20261220210000), the question, the purpose of each chapter and the
// glossary behind the panel "Struktura". Each call is one withActor transaction
// over one RPC of schema collaboration; the RPC decides who may: the student who
// owns the work, alone, decided on every call (C-23). Nothing here reads or
// writes the document. The answer is a closed status, never a database message
// or SQLSTATE: ZD401 is unauthenticated, ZD403 not_found (one answer for "not
// yours", "not there" and "no relation"), ZD422 invalid, anything else
// unavailable. A row of an unexpected shape is unavailable too.
import type { ActorTransaction, WithActor } from "../index.ts";

export type PlanPurpose = { readonly nodeId: string; readonly purpose: string };
export type PlanTerm = {
  readonly term: string;
  readonly definition: string;
  readonly kind: "term" | "abbreviation";
};
export type WorkPlan = {
  readonly question: string | null;
  readonly purposes: readonly PlanPurpose[];
  readonly terms: readonly PlanTerm[];
  readonly updatedAt: string | null;
};
export type WorkPlanInput = Pick<WorkPlan, "question" | "purposes" | "terms">;

export type WorkPlanRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type WorkPlanAnswer = { readonly status: "ok"; readonly plan: WorkPlan } | WorkPlanRefusal;

export type WorkPlanStore = {
  read(token: string, documentId: string): Promise<WorkPlanAnswer>;
  write(token: string, documentId: string, plan: WorkPlanInput): Promise<WorkPlanAnswer>;
};

const COLUMNS = 'question, purposes, terms, updated_at AS "updatedAt"';
const SQL = {
  read: `SELECT ${COLUMNS} FROM collaboration.get_work_plan($1)`,
  write: `SELECT ${COLUMNS} FROM collaboration.put_work_plan($1, $2, $3::jsonb, $4::jsonb)`,
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

function refusal(thrown: unknown): WorkPlanRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

const EMPTY: WorkPlan = { question: null, purposes: [], terms: [], updatedAt: null };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Malformed();
  return value as Record<string, unknown>;
}
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Malformed();
  return value;
};
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Malformed();
  return value;
}

function toPlan(rows: readonly Record<string, unknown>[]): WorkPlan {
  if (rows.length === 0) return EMPTY;
  if (rows.length !== 1) throw new Malformed();
  const row = rows[0]!;
  const at = row["updatedAt"];
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Malformed();
  return {
    question: row["question"] === null ? null : text(row["question"]),
    purposes: list(row["purposes"]).map((item) => {
      const e = object(item);
      return { nodeId: text(e["nodeId"]), purpose: text(e["purpose"]) };
    }),
    terms: list(row["terms"]).map((item) => {
      const e = object(item);
      const kind = e["kind"];
      if (kind !== "term" && kind !== "abbreviation") throw new Malformed();
      return { term: text(e["term"]), definition: text(e["definition"]), kind };
    }),
    updatedAt: at.toISOString(),
  };
}

export function createWorkPlanStore(withActor: WithActor): WorkPlanStore {
  async function run(token: string, sql: string, params: unknown[]): Promise<WorkPlanAnswer> {
    try {
      return await withActor(token, async (tx: ActorTransaction) => ({
        status: "ok" as const,
        plan: toPlan((await tx.query<Record<string, unknown>>(sql, params)).rows),
      }));
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  return {
    read: (token, documentId) => run(token, SQL.read, [documentId]),
    write: (token, documentId, plan) =>
      run(token, SQL.write, [
        documentId,
        plan.question,
        JSON.stringify(plan.purposes),
        JSON.stringify(plan.terms),
      ]),
  };
}
