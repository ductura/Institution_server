// SRV-NF1-PREDANO (Ductus#2055 c.7145546227, NF-1 P-6): the caller's own
// submission state for every assignment of the workspace at once, for
// student.assignment-submissions.get. One withActor transaction, one STABLE
// statement over app.student_workspace() (DAN-309) and app.my_submission_state()
// (SRV-20), nothing written; the same set of assignments as my-assignment-work.ts.
// The session determines the caller, so only the caller's own assignments are
// read. Each row is checked as my-submission-state.ts checks the one row of
// student.submission.get (storedStateOf), and the receipt text is handed on as
// stored: server/institution/student-assignment-submissions-route.ts binds it.
// A row the port cannot vouch for, not_found among them, makes the whole answer
// ROW_MALFORMED; the list is never partial. The errors are those of
// my-submission-state.ts, whose texts are in locales/hr.json under mySubmissionState.

import type { Result } from "../domain/index.ts";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
  NOT_FOUND,
  storedStateOf,
  type StoredSubmissionState,
} from "./my-submission-state.ts";
import type { WithActor } from "./with-actor.ts";

export type StoredAssignmentSubmission = {
  assignmentId: string;
  stored: StoredSubmissionState;
};

export type MyAssignmentSubmissionsReader = {
  /** One row per assignment of the caller's open student courses, by assignmentId. */
  read(token: string | undefined): Promise<Result<StoredAssignmentSubmission[]>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// DISTINCT: the workspace has a row per work, the state is per assignment. Keep the
// assignment if the submission function returns no row, so the parser refuses an
// incomplete result instead of silently hiding an assignment.
const SQL = `SELECT w.assignment_id, s.state, s.revision::text AS revision,
    to_char(s.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
    s.receipt_payload, s.payload_digest_sha256, s.signature
  FROM (SELECT DISTINCT assignment_id FROM app.student_workspace()) w
  LEFT JOIN LATERAL app.my_submission_state(w.assignment_id) s ON true`;

/** The rows by assignmentId, or null for anything the port cannot vouch for. */
function listOf(rows: unknown): StoredAssignmentSubmission[] | null {
  if (!Array.isArray(rows)) return null;
  const list: StoredAssignmentSubmission[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    if (!Object.hasOwn(rows, index)) return null;
    const row: unknown = rows[index];
    if (typeof row !== "object" || row === null) return null;
    const id = Object.hasOwn(row, "assignment_id")
      ? (row as Record<string, unknown>)["assignment_id"]
      : undefined;
    if (typeof id !== "string" || !UUID.test(id) || seen.has(id)) return null;
    const stored = storedStateOf(row);
    if (stored === null || stored === NOT_FOUND) return null;
    seen.add(id);
    list.push({ assignmentId: id, stored });
  }
  return list.sort((a, b) =>
    a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0,
  );
}

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createMyAssignmentSubmissionsReader(
  withActor: WithActor,
): MyAssignmentSubmissionsReader {
  return {
    async read(token) {
      if (token === undefined || !TOKEN.test(token)) {
        return { ok: false, error: MY_SUBMISSION_STATE_UNAUTHENTICATED };
      }
      let rows: unknown;
      try {
        rows = await withActor(token, async (tx) => (await tx.query(SQL, [])).rows);
      } catch (thrown) {
        const error =
          codeOf(thrown) === "ZD401"
            ? MY_SUBMISSION_STATE_UNAUTHENTICATED
            : MY_SUBMISSION_STATE_DATABASE_ERROR;
        return { ok: false, error };
      }
      let list: StoredAssignmentSubmission[] | null;
      try {
        list = listOf(rows);
      } catch {
        list = null;
      }
      return list === null
        ? { ok: false, error: MY_SUBMISSION_STATE_ROW_MALFORMED }
        : { ok: true, value: list };
    },
  };
}
