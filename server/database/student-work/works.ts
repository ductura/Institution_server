import type { WithActor } from "../index.ts";

import { languageOf, StudentWorkRowError } from "./start.ts";

// SRV-1412 (M2.3, DAN-309): the caller's own started works ("Moji radovi").
// One STABLE statement over app.student_workspace() (only the caller's open
// student memberships and own work), with the caller's due time
// (app.student_effective_due_at), the submission state of SRV-20
// (app.my_submission_state) and the language of the work
// (institution.work_language). Nothing of a teacher is read. Instants are
// formatted by the database in UTC, never by a driver's time zone.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO})`;
const WORKS_SQL = `SELECT w.document_id, w.assignment_id::text AS assignment_id, w.title,
       w.course_id::text AS course_id, w.course_name, w.academic_year,
       ${iso("coalesce(app.student_effective_due_at(w.assignment_id), w.due_at)")} AS due_at,
       w.server_revision::text AS revision, s.state, ${iso("s.requested_at")} AS requested_at,
       institution.work_language(w.assignment_id, app.current_user_id()) AS language
  FROM app.student_workspace() w
  LEFT JOIN LATERAL app.my_submission_state(w.assignment_id) s ON true
 WHERE w.document_id IS NOT NULL`;

export type StudentWorkRow = {
  readonly workId: string;
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly courseId: string;
  readonly courseName: string;
  readonly academicYear: string;
  readonly dueAt: string;
  readonly state: "in_progress" | "submitted";
  readonly revision: number;
  readonly submittedAt: string | null;
  readonly language: "hr" | "en";
};

const own = (row: object, key: string): unknown =>
  Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;

function text(row: object, key: string): string {
  const value = own(row, key);
  if (typeof value !== "string" || value === "") throw new StudentWorkRowError(key);
  return value;
}

function revisionOf(value: unknown): number {
  const n =
    typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new StudentWorkRowError("revision");
  return n;
}

export function workOf(row: unknown): StudentWorkRow {
  if (typeof row !== "object" || row === null) throw new StudentWorkRowError("row");
  const submission = own(row, "state");
  const requestedAt = own(row, "requested_at");
  let state: StudentWorkRow["state"];
  let submittedAt: string | null;
  if (submission === "none") {
    state = "in_progress";
    submittedAt = null;
  } else if (
    (submission === "ceka" || submission === "potvrdeno") &&
    typeof requestedAt === "string"
  ) {
    state = "submitted";
    submittedAt = requestedAt;
  } else {
    throw new StudentWorkRowError("submission");
  }
  return {
    workId: text(row, "document_id"),
    assignmentId: text(row, "assignment_id"),
    assignmentTitle: text(row, "title"),
    courseId: text(row, "course_id"),
    courseName: text(row, "course_name"),
    academicYear: text(row, "academic_year"),
    dueAt: text(row, "due_at"),
    state,
    revision: revisionOf(own(row, "revision")),
    submittedAt,
    language: languageOf(own(row, "language")),
  };
}

/** By due time, then assignment id, then work id; one work per assignment. */
export function worksOf(rows: unknown): StudentWorkRow[] {
  if (!Array.isArray(rows)) throw new StudentWorkRowError("rows");
  const works = rows.map(workOf);
  const assignments = new Set(works.map((work) => work.assignmentId));
  if (assignments.size !== works.length) throw new StudentWorkRowError("duplicate assignment");
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return works.sort(
    (a, b) =>
      order(a.dueAt, b.dueAt) || order(a.assignmentId, b.assignmentId) || order(a.workId, b.workId),
  );
}

export function createStudentWorksReader(withActor: WithActor) {
  return {
    /** The caller's own started works; possibly none. */
    works: (token: string): Promise<StudentWorkRow[]> =>
      withActor(token, async (tx) => worksOf((await tx.query(WORKS_SQL, [])).rows)),
  };
}
