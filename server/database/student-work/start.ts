import type { WithActor } from "../index.ts";

// SRV-1412 (M2.1, DAN-330, DAN-331): the student starts the own work on one
// assignment. One transaction: app.open_student_work with start makes the
// work at most once per student and assignment (its unique key decides a
// parallel start), then the version of the institution's rules the assignment
// is pinned to and the language of the work are read in the same snapshot.
// Who may is decided by the database: another course's assignment and an
// unknown one are not_found.
const OPEN_SQL = "SELECT outcome, document_id FROM app.open_student_work($1::uuid, true)";
const RULES_SQL = "SELECT version FROM app.assignment_institution_config($1::uuid)";
const LANGUAGE_SQL =
  "SELECT institution.work_language($1::uuid, app.current_user_id()) AS language";

export type StartedWork = {
  readonly workId: string;
  readonly rulesVersion: number | null;
  readonly language: "hr" | "en";
};

export type StartWorkOutcome =
  | { readonly status: "started"; readonly work: StartedWork }
  | { readonly status: "unauthenticated" | "not_found" | "not_accepting" | "not_configured" };

// A Map, so an outcome such as `__proto__` is no refusal.
const REFUSALS = new Map<unknown, StartWorkOutcome>([
  ["unauthenticated", { status: "unauthenticated" }],
  ["not_found", { status: "not_found" }],
  ["not_accepting", { status: "not_accepting" }],
  ["not_configured", { status: "not_configured" }],
]);

/** A row of a form the statements never return; rolls the transaction back. */
export class StudentWorkRowError extends Error {
  constructor(what: string) {
    super(`student work: malformed ${what}`);
  }
}

const own = (row: unknown, key: string): unknown =>
  typeof row === "object" && row !== null && Object.hasOwn(row, key)
    ? (row as Record<string, unknown>)[key]
    : undefined;

function single(rows: unknown, what: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) throw new StudentWorkRowError(what);
  return rows[0];
}

export function rulesVersionOf(rows: unknown): number | null {
  if (!Array.isArray(rows) || rows.length > 1) throw new StudentWorkRowError("rules version");
  if (rows.length === 0) return null;
  const version = own(rows[0], "version");
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new StudentWorkRowError("rules version");
  }
  return version;
}

export function languageOf(value: unknown): "hr" | "en" {
  if (value === "hr" || value === "en") return value;
  throw new StudentWorkRowError("language");
}

export function createStudentWorkStarter(withActor: WithActor) {
  return {
    /** The caller's work on the assignment, made now or before. */
    start: (token: string, assignmentId: string): Promise<StartWorkOutcome> =>
      withActor(token, async (tx) => {
        const opened = single((await tx.query(OPEN_SQL, [assignmentId])).rows, "open");
        const outcome = own(opened, "outcome");
        const refusal = REFUSALS.get(outcome);
        if (refusal !== undefined) return refusal;
        const workId = own(opened, "document_id");
        if (outcome !== "opened" || typeof workId !== "string" || workId === "") {
          throw new StudentWorkRowError("open");
        }
        const rulesVersion = rulesVersionOf((await tx.query(RULES_SQL, [assignmentId])).rows);
        const language = languageOf(
          own(single((await tx.query(LANGUAGE_SQL, [assignmentId])).rows, "language"), "language"),
        );
        return { status: "started", work: { workId, rulesVersion, language } };
      }),
  };
}
