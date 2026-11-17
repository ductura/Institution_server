// The state of the student's own work per assignment (DAN-989-2a; contract
// Ductus#1836 c.6957393091), for the route student.assignment-work.get of
// DAN-989-1. One withActor transaction, one STABLE statement over
// app.student_workspace() (DAN-309, pgTAP 091), nothing written. Who asks comes
// only from the session token; the function lists only the caller's open
// student courses and only their own work and submission. A document stands for
// the work: open_work writes the project and its document together. A
// submission goes through a submission_request bound to that document, at
// revision 1 or later, so a submission without a document is no row the
// function returns. One row the port cannot vouch for makes the whole answer
// row_malformed; the list is never partial. Unlike my-access-log.ts, a row is
// read only through its own keys, so an inherited or a `__proto__` column is
// none, and a row that throws is row_malformed, never a rejected promise.

import type { AppError, Result } from "../domain/index.ts";

import { count } from "./open-work.ts";
import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** No session behind the token: a malformed token, or ZD401. */
export const MY_ASSIGNMENT_WORK_UNAUTHENTICATED = error(
  "MY_ASSIGNMENT_WORK_UNAUTHENTICATED",
  "myAssignmentWork.unauthenticated",
);
/** A row that is not what app.student_workspace() returns. */
export const MY_ASSIGNMENT_WORK_ROW_MALFORMED = error(
  "MY_ASSIGNMENT_WORK_ROW_MALFORMED",
  "myAssignmentWork.row_malformed",
);
/** Any other error of the database or of withActor. */
export const MY_ASSIGNMENT_WORK_DATABASE_ERROR = error(
  "MY_ASSIGNMENT_WORK_DATABASE_ERROR",
  "myAssignmentWork.database_error",
);
export const MY_ASSIGNMENT_WORK_ERRORS: readonly AppError[] = [
  MY_ASSIGNMENT_WORK_UNAUTHENTICATED,
  MY_ASSIGNMENT_WORK_ROW_MALFORMED,
  MY_ASSIGNMENT_WORK_DATABASE_ERROR,
];

export type WorkState = "not_started" | "in_progress" | "submitted";
export type AssignmentWork = { assignmentId: string; workState: WorkState };

export type MyAssignmentWorkReader = {
  /** One row per assignment of the caller's open student courses, by assignmentId. */
  read(token: string | undefined): Promise<Result<AssignmentWork[]>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQL = "SELECT assignment_id, document_id, submitted_revision FROM app.student_workspace()";

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

/** An own column of the row, or undefined; never one from the prototype. */
const own = (row: object, key: string): unknown =>
  Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;

/**
 * A document id: 1 to 256 code points as `length()` counts, trimmed, no control characters.
 * Stricter than the CHECK of `evidence.document` (JS trim and C1 controls); ids are
 * generated uuids, so no real id is refused.
 */
function isDocumentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    [...value].length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/** One row as [assignmentId, state, revision], or null when it is not what the function returns. */
function workOf(row: unknown): [string, WorkState, number | null] | null {
  if (typeof row !== "object" || row === null) return null;
  const id = own(row, "assignment_id");
  const document = own(row, "document_id");
  const revision = own(row, "submitted_revision");
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (document !== null && !isDocumentId(document)) return null;
  if (revision === null) return [id, document === null ? "not_started" : "in_progress", null];
  const n = count(revision);
  return n !== null && n >= 1 && document !== null ? [id, "submitted", n] : null;
}

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The state per assignment; repeated rows (several documents) must agree, else null. */
function statesOf(rows: unknown): AssignmentWork[] | null {
  if (!Array.isArray(rows)) return null;
  const states = new Map<string, { state: WorkState; revision: number | null }>();
  for (const row of rows) {
    const work = workOf(row);
    if (work === null) return null;
    const [id, state, revision] = work;
    const seen = states.get(id);
    if (seen !== undefined && (seen.state !== state || seen.revision !== revision)) return null;
    states.set(id, { state, revision });
  }
  return [...states]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assignmentId, { state }]) => ({ assignmentId, workState: state }));
}

export function createMyAssignmentWorkReader(withActor: WithActor): MyAssignmentWorkReader {
  return {
    async read(token) {
      if (token === undefined || !TOKEN.test(token))
        return fail(MY_ASSIGNMENT_WORK_UNAUTHENTICATED);
      let rows: unknown;
      try {
        rows = await withActor(token, async (tx) => (await tx.query(SQL, [])).rows);
      } catch (thrown) {
        return fail(
          codeOf(thrown) === "ZD401"
            ? MY_ASSIGNMENT_WORK_UNAUTHENTICATED
            : MY_ASSIGNMENT_WORK_DATABASE_ERROR,
        );
      }
      let states: AssignmentWork[] | null;
      try {
        states = statesOf(rows);
      } catch {
        states = null;
      }
      return states === null ? fail(MY_ASSIGNMENT_WORK_ROW_MALFORMED) : { ok: true, value: states };
    },
  };
}
