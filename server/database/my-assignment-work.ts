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
//
// SRV-NF4-IZNIMKA-PREDAJA (NF-4, NZ-5 B): the same statement reads the
// caller's own latest late-submission exception per assignment through
// app.student_late_exception_until (20261219300000), the bridge the
// submission request honours; null for none. Only the caller's own record is
// ever read, so no other student's exception can reach the answer.

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
export type LateException = { untilAt: string };
export type AssignmentWork = {
  assignmentId: string;
  workState: WorkState;
  /** The caller's own latest late-submission exception; absent when there is none. */
  lateException?: LateException;
};

export type MyAssignmentWorkReader = {
  /** One row per assignment of the caller's open student courses, by assignmentId. */
  read(token: string | undefined): Promise<Result<AssignmentWork[]>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Keep the workspace row if the submission function returns no row, so the
// parser refuses an incomplete result instead of silently hiding an assignment.
const SQL = `SELECT w.assignment_id, w.document_id, s.state,
       app.student_late_exception_until(w.assignment_id) AS late_until
  FROM app.student_workspace() w
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

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The exception time as Date.toISOString writes it: null for none, undefined
 * for a value the port cannot vouch for (not a Date, not finite, or outside
 * the years 1000 to 9999 the contract's Instant pattern admits).
 */
function lateUntilOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined;
  const iso = value.toISOString();
  return INSTANT.test(iso) && iso >= "1000" ? iso : undefined;
}

type Work = [string, WorkState, SubmissionState, string | null];

/** One validated row, including the submission state for duplicate checks. */
function workOf(row: unknown): Work | null {
  if (typeof row !== "object" || row === null) return null;
  const id = own(row, "assignment_id");
  const document = own(row, "document_id");
  const submission = own(row, "state");
  const until = lateUntilOf(own(row, "late_until"));
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (document !== null && !isDocumentId(document)) return null;
  if (until === undefined) return null;
  if (submission === "none") {
    return [id, document === null ? "not_started" : "in_progress", submission, until];
  }
  return document !== null && (submission === "ceka" || submission === "potvrdeno")
    ? [id, "submitted", submission, until]
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
  const states = new Map<
    string,
    { state: WorkState; submission: SubmissionState; until: string | null }
  >();
  for (const row of rows) {
    const work = workOf(row);
    if (work === null) return null;
    const [id, state, submission, until] = work;
    const seen = states.get(id);
    if (
      seen !== undefined &&
      (seen.state !== state || seen.submission !== submission || seen.until !== until)
    ) {
      return null;
    }
    states.set(id, { state, submission, until });
  }
  return [...states]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assignmentId, { state, until }]) =>
      until === null
        ? { assignmentId, workState: state }
        : { assignmentId, workState: state, lateException: { untilAt: until } },
    );
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
