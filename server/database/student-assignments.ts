// SRV-09 (Ductus#2028 c.7008147932): the port of institution.student_assignments()
// (20261119140000, SRV-08), the student's assignments with their course. One
// withActor transaction of one STABLE statement, nothing written; who asks
// comes only from the session token. The rows come in the contract's order:
// course name (Croatian collation, ICU "hr"), course id, due time, assignment
// id; the route keeps it. Every row is checked whole: a row the
// port cannot vouch for makes the whole read unavailable, never a partial list.
// Only the columns the route can answer exactly are read; the groups, mentors
// and teachers of the function do not yet have the contract's shape (group ids,
// given and family names apart; Ductus#2028 c.7009610321).
import type { WithActor } from "./with-actor.ts";

export type StudentAssignmentRow = {
  readonly assignmentId: string;
  readonly courseId: string;
  readonly courseName: string;
  readonly academicYear: string;
  readonly title: string;
  readonly workType: string;
  readonly dueAt: string;
  readonly extendedDueAt: string | null;
  readonly acknowledged: boolean;
};

export type StudentAssignmentsRead =
  | { readonly status: "ok"; readonly rows: readonly StudentAssignmentRow[] }
  | { readonly status: "unauthenticated" | "unavailable" };

export type StudentAssignmentsReader = (token: string) => Promise<StudentAssignmentsRead>;

const SQL = `SELECT assignment_id AS "assignmentId", course_id AS "courseId", course_name AS "courseName",
  academic_year AS "academicYear", title, work_type AS "workType", due_at AS "dueAt",
  extended_due_at AS "extendedDueAt", acknowledged
  FROM institution.student_assignments()
  ORDER BY course_name COLLATE "hr-x-icu", course_id, due_at, assignment_id`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const instant = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

/** One row as the route reads it, or null when it is not what the function returns. */
function rowOf(row: Record<string, unknown>): StudentAssignmentRow | null {
  const { assignmentId, courseId, courseName, academicYear, title, workType } = row;
  const dueAt = instant(row.dueAt);
  const extendedDueAt = row.extendedDueAt === null ? null : instant(row.extendedDueAt);
  if (
    !text(assignmentId) ||
    !UUID.test(assignmentId) ||
    !text(courseId) ||
    !UUID.test(courseId) ||
    !text(courseName) ||
    !text(academicYear) ||
    !text(title) ||
    !text(workType) ||
    dueAt === null ||
    (row.extendedDueAt !== null && extendedDueAt === null) ||
    typeof row.acknowledged !== "boolean"
  ) {
    return null;
  }
  return {
    ...{ assignmentId, courseId, courseName, academicYear, title, workType, dueAt },
    extendedDueAt,
    acknowledged: row.acknowledged,
  };
}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

export function createStudentAssignmentsReader(withActor: WithActor): StudentAssignmentsReader {
  return async (token) => {
    let rows: Record<string, unknown>[];
    try {
      rows = await withActor(token, async (tx) => (await tx.query(SQL)).rows);
    } catch (thrown) {
      return { status: codeOf(thrown) === "ZD401" ? "unauthenticated" : "unavailable" };
    }
    const read: StudentAssignmentRow[] = [];
    for (const row of rows) {
      const checked = rowOf(row);
      if (checked === null) return { status: "unavailable" };
      read.push(checked);
    }
    return { status: "ok", rows: read };
  };
}

// INT-31 (Ductus#2055): the port of institution.student_mentored_assignments(),
// the assignments of the caller's open mentorships (no course), under the same
// predicate as app.lock_student_assignment. Same rules as above: one STABLE
// statement in one withActor transaction, every row checked whole, never a
// partial list. The mentor's name may be missing (no person_name row); then the
// row carries no mentor, never half a name.

export type StudentMentoredAssignmentRow = {
  readonly assignmentId: string;
  readonly mentorshipId: string;
  readonly title: string;
  readonly workType: string;
  readonly dueAt: string;
  readonly extendedDueAt: string | null;
  readonly acknowledged: boolean;
  readonly mentor: {
    readonly id: string;
    readonly givenName: string;
    readonly familyName: string;
  } | null;
};

export type StudentMentoredAssignmentsRead =
  | { readonly status: "ok"; readonly rows: readonly StudentMentoredAssignmentRow[] }
  | { readonly status: "unauthenticated" | "unavailable" };

export type StudentMentoredAssignmentsReader = (
  token: string,
) => Promise<StudentMentoredAssignmentsRead>;

const MENTORED_SQL = `SELECT assignment_id AS "assignmentId", mentorship_id AS "mentorshipId", title,
  work_type AS "workType", due_at AS "dueAt", extended_due_at AS "extendedDueAt", acknowledged,
  mentor_id AS "mentorId", mentor_given_name AS "mentorGivenName", mentor_family_name AS "mentorFamilyName"
  FROM institution.student_mentored_assignments()
  ORDER BY due_at, assignment_id`;

/** One mentored row as the route reads it, or null when it is not what the function returns. */
function mentoredRowOf(row: Record<string, unknown>): StudentMentoredAssignmentRow | null {
  const { assignmentId, mentorshipId, title, workType, mentorId } = row;
  const { mentorGivenName, mentorFamilyName } = row;
  const dueAt = instant(row.dueAt);
  const extendedDueAt = row.extendedDueAt === null ? null : instant(row.extendedDueAt);
  const named = text(mentorGivenName) && text(mentorFamilyName);
  const unnamed = mentorGivenName === null && mentorFamilyName === null;
  if (
    !text(assignmentId) ||
    !UUID.test(assignmentId) ||
    !text(mentorshipId) ||
    !UUID.test(mentorshipId) ||
    !text(mentorId) ||
    !UUID.test(mentorId) ||
    !text(title) ||
    !text(workType) ||
    dueAt === null ||
    (row.extendedDueAt !== null && extendedDueAt === null) ||
    typeof row.acknowledged !== "boolean" ||
    !(named || unnamed)
  ) {
    return null;
  }
  return {
    ...{ assignmentId, mentorshipId, title, workType, dueAt, extendedDueAt },
    acknowledged: row.acknowledged,
    mentor: named
      ? {
          id: mentorId,
          givenName: mentorGivenName as string,
          familyName: mentorFamilyName as string,
        }
      : null,
  };
}

export function createStudentMentoredAssignmentsReader(
  withActor: WithActor,
): StudentMentoredAssignmentsReader {
  return async (token) => {
    let rows: Record<string, unknown>[];
    try {
      rows = await withActor(token, async (tx) => (await tx.query(MENTORED_SQL)).rows);
    } catch (thrown) {
      return { status: codeOf(thrown) === "ZD401" ? "unauthenticated" : "unavailable" };
    }
    const read: StudentMentoredAssignmentRow[] = [];
    for (const row of rows) {
      const checked = mentoredRowOf(row);
      if (checked === null) return { status: "unavailable" };
      read.push(checked);
    }
    return { status: "ok", rows: read };
  };
}
