// The submissions of assignments for their teacher (contracts
// teacher.submissions.get and teacher.assignment-submissions.post). Port of
// Ductus src/server/evidence/assignment-submissions.ts at 078c780
// (submissionOf, SQL, readAssignmentSubmissionsMany) without a change of
// logic; changes are of form: the token's shape is the route's
// (liveSessionTokenFromCookie), a failure is an outcome whose reason names no
// SQLSTATE, and nothing is logged here. Who asks comes only from the session
// bound into withActor; the database decides who gets rows
// (app.assignment_submissions and app.assignment_works, both for the
// assignment's teacher only, one row per student with an open membership).
// Every other caller gets the same empty list. Nothing here writes, and the
// answer names no text, name, exact time, deadline, hash or submission id.
import type { WithActor } from "./with-actor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^[0-9]{1,16}$/;

export type AssignmentSubmission = {
  readonly studentId: string;
  /** The student's work, null while there is none. */
  readonly documentId: string | null;
  readonly submitted: boolean;
  /** These three are null exactly when submitted is false. */
  readonly revision: number | null;
  /** ISO UTC, always on a whole minute. */
  readonly requestedMinute: string | null;
  readonly afterDeadline: boolean | null;
};

/** One entry per distinct lower-case UUID asked for, in the order of first appearance. */
export type AssignmentSubmissionsOutcome =
  | {
      readonly status: "ok";
      readonly submissions: ReadonlyMap<string, readonly AssignmentSubmission[]>;
    }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable"; readonly reason: string };

export type AssignmentSubmissionsReader = (
  token: string,
  assignmentIds: readonly string[],
) => Promise<AssignmentSubmissionsOutcome>;

type Row = Record<string, unknown>;

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** Ductus isDocumentId (src/domain/collaboration): 1 to 256 code points, trimmed, no control character. */
function isDocumentId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = [...value].length;
  return length >= 1 && length <= 256 && !/\p{Cc}/u.test(value);
}

/** One row as the contract's submission, or null when it is not what the functions return. */
export function submissionOf(row: Row): AssignmentSubmission | null {
  const { student_id: studentId, document_id: documentId, submitted } = row;
  if (typeof studentId !== "string" || !UUID.test(studentId)) return null;
  if (documentId !== null && !isDocumentId(documentId)) return null;
  if (submitted === false) {
    if (row.revision !== null || row.requested_minute !== null || row.after_deadline !== null) {
      return null;
    }
    return {
      studentId,
      documentId,
      submitted,
      revision: null,
      requestedMinute: null,
      afterDeadline: null,
    };
  }
  if (submitted !== true || typeof row.after_deadline !== "boolean") return null;
  // int8 travels as text: only a safe integer is a revision.
  const revision =
    typeof row.revision === "string" && DIGITS.test(row.revision) ? Number(row.revision) : NaN;
  const minute = row.requested_minute;
  if (
    !Number.isSafeInteger(revision) ||
    !(minute instanceof Date) ||
    !Number.isFinite(minute.getTime()) ||
    minute.getTime() % 60_000 !== 0
  ) {
    return null;
  }
  return {
    studentId,
    documentId,
    submitted,
    revision,
    requestedMinute: minute.toISOString(),
    afterDeadline: row.after_deadline,
  };
}

// Both functions decide the teacher on every call; one statement, one snapshot.
const SQL = `SELECT a.id::text AS assignment_id, x.*
  FROM unnest($1::uuid[]) WITH ORDINALITY AS a (id, n)
  CROSS JOIN LATERAL (
    SELECT s.student_id::text AS student_id, w.document_id, s.submitted, s.revision::text AS revision,
           s.requested_minute, s.after_deadline
      FROM app.assignment_submissions(a.id) s
      LEFT JOIN app.assignment_works(a.id) w ON w.student_id = s.student_id
  ) x
 ORDER BY a.n, x.student_id::uuid`;

/**
 * The submissions of many assignments in one transaction and one statement.
 * Malformed ids are left out and map to no entry (the routes refuse or
 * answer them before). A failure, or any row it cannot vouch for, answers for
 * the whole read: never "not submitted" in place of an unknown.
 */
export function createAssignmentSubmissionsReader(
  withActor: WithActor,
): AssignmentSubmissionsReader {
  return async (token, assignmentIds) => {
    const ids = [
      ...new Set(assignmentIds.map((id) => id.toLowerCase()).filter((id) => UUID.test(id))),
    ];
    const submissions = new Map<string, AssignmentSubmission[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return { status: "ok", submissions };
    let rows: Row[];
    try {
      rows = (await withActor(token, (tx) => tx.query<Row>(SQL, [ids]))).rows;
    } catch (thrown) {
      if (codeOf(thrown) === "ZD401") return { status: "unauthenticated" };
      return { status: "unavailable", reason: "database_error" };
    }
    for (const row of rows) {
      const list =
        typeof row.assignment_id === "string" ? submissions.get(row.assignment_id) : undefined;
      const submission = submissionOf(row);
      // A second row for a student would mean a second work: no answer rather than a guess.
      if (
        list === undefined ||
        submission === null ||
        list.some((s) => s.studentId === submission.studentId)
      ) {
        return { status: "unavailable", reason: "row_malformed" };
      }
      list.push(submission);
    }
    return { status: "ok", submissions };
  };
}
