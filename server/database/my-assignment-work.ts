// The state of the student's own work per assignment (DAN-989-2a; contract
// Ductus#1836 c.6957393091), for the route student.assignment-work.get of
// DAN-989-1. One withActor transaction, one STABLE statement over
// app.student_workspace() (DAN-309) and app.my_submission_state() (SRV-20),
// nothing written. The session determines the caller. The workspace lists the
// caller's assignments and work, and SRV-20 supplies the submission state in
// the same snapshot. A document stands for
// the work: open_work writes the project and its document together. A
// submission goes through a submission_request bound to that document, at
// revision 1 or later, so a submission without a document is no row the
// function returns. One row the port cannot vouch for makes the whole answer
// row_malformed; the list is never partial. Unlike my-access-log.ts, a row is
// read only through its own keys, so an inherited or a `__proto__` column is
// none, and a row that throws is row_malformed, never a rejected promise.

import type { AppError, Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** No session behind the token: a malformed token, or ZD401. */
export const MY_ASSIGNMENT_WORK_UNAUTHENTICATED = error(
  "MY_ASSIGNMENT_WORK_UNAUTHENTICATED",
  "myAssignmentWork.unauthenticated",
);
/** A row inconsistent with the workspace or SRV-20 submission state. */
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
  /** One row per assignment of the caller's open student courses and mentorships, by assignmentId. */
  read(token: string | undefined): Promise<Result<AssignmentWork[]>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Keep the workspace row if the submission function returns no row, so the
// parser refuses an incomplete result instead of silently hiding an assignment.
// INT-31 (Ductus#2055): the assignments of the caller's open mentorships come
// from the sibling app.student_mentored_workspace() (no course), as
// student.mentored-assignments.get lists them.
const SQL = `SELECT w.assignment_id, w.document_id, s.state
  FROM (SELECT assignment_id, document_id FROM app.student_workspace()
        UNION ALL
        SELECT assignment_id, document_id FROM app.student_mentored_workspace()) w
  LEFT JOIN LATERAL app.my_submission_state(w.assignment_id) s ON true`;

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

type SubmissionState = "none" | "ceka" | "potvrdeno";

/** One validated row, including the submission state for duplicate checks. */
function workOf(row: unknown): [string, WorkState, SubmissionState] | null {
  if (typeof row !== "object" || row === null) return null;
  const id = own(row, "assignment_id");
  const document = own(row, "document_id");
  const submission = own(row, "state");
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (document !== null && !isDocumentId(document)) return null;
  if (submission === "none") {
    return [id, document === null ? "not_started" : "in_progress", submission];
  }
  return document !== null && (submission === "ceka" || submission === "potvrdeno")
    ? [id, "submitted", submission]
    : null;
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
  const states = new Map<string, { state: WorkState; submission: SubmissionState }>();
  for (const row of rows) {
    const work = workOf(row);
    if (work === null) return null;
    const [id, state, submission] = work;
    const seen = states.get(id);
    if (seen !== undefined && (seen.state !== state || seen.submission !== submission)) return null;
    states.set(id, { state, submission });
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
