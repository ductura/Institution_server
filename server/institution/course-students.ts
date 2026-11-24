import { isWorkId } from "../contracts/index.ts";
import type { WithActor } from "../database/with-actor.ts";

/**
 * DAN-344 R-2 (#923, contract c.6434766713 point 2; D-170 as amended on #87):
 * the students of one course with their name pair, for the course's teacher
 * page (T02). Who asks comes only from the session cookie bound into
 * withActor; app.teacher_course_students decides on every call who gets rows
 * (the course's teacher only, one row per open student membership). Every
 * other caller gets the same empty list. Nothing here writes, and nothing of
 * a work is read.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const NAME_MAX = 255;

export type NamedStudent = {
  studentId: string;
  /** Both null when the account has no name pair (#757 D1); never a stand-in. */
  givenName: string | null;
  familyName: string | null;
};

type StudentsRead<Student> =
  { kind: "ok"; students: Student[] } | { kind: "unauthorized" | "unavailable" };
export type NamedStudentsRead = StudentsRead<NamedStudent>;

type Row = Record<string, unknown>;
type ReadFailure =
  | "course students read failed"
  | "assignment names read failed"
  | "assignment overview read failed";

function codeOf(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isName(value: unknown): value is string {
  // Code points, as length() in the database counts (F-149).
  return typeof value === "string" && value.length >= 1 && [...value].length <= NAME_MAX;
}

/** One row as a named student, or null when it is not what the functions return. */
export function namedStudentOf(row: Row): NamedStudent | null {
  const { student_id: studentId, given_name: givenName, family_name: familyName } = row;
  if (typeof studentId !== "string" || !UUID.test(studentId)) return null;
  if (isName(givenName) && isName(familyName)) return { studentId, givenName, familyName };
  if (givenName === null && familyName === null)
    return { studentId, givenName: null, familyName: null };
  return null;
}

/**
 * Runs one list function for one id inside withActor and parses every row.
 * A malformed id is the same empty list as any refusal, without asking. A
 * failure, or any row it cannot vouch for, answers for the whole read: never
 * a partial list.
 */
async function readStudents<Student>(
  sessionToken: string | undefined,
  withActor: WithActor,
  id: string,
  sql: string,
  failure: ReadFailure,
  parse: (rows: Row[]) => Student[] | null,
): Promise<StudentsRead<Student>> {
  if (sessionToken === undefined || !TOKEN.test(sessionToken)) return { kind: "unauthorized" };
  const key = id.toLowerCase();
  if (!UUID.test(key)) return { kind: "ok", students: [] };
  let rows: Row[];
  try {
    rows = (await withActor(sessionToken, (tx) => tx.query<Row>(sql, [key]))).rows;
  } catch (error) {
    const code = codeOf(error);
    if (code === "ZD401") return { kind: "unauthorized" };
    console.error(failure, code !== undefined && SQLSTATE.test(code) ? code : "unknown");
    return { kind: "unavailable" };
  }
  const students = parse(rows);
  if (students !== null) return { kind: "ok", students };
  console.error(failure, "row_malformed");
  return { kind: "unavailable" };
}

function uniqueStudents<Student extends NamedStudent>(
  rows: Row[],
  parseStudent: (row: Row) => Student | null,
): Student[] | null {
  const students = new Map<string, Student>();
  for (const row of rows) {
    const student = parseStudent(row);
    if (student === null || students.has(student.studentId)) return null;
    students.set(student.studentId, student);
  }
  return [...students.values()];
}

export function readNamedStudents(
  token: string | undefined,
  withActor: WithActor,
  id: string,
  sql: string,
  failure: "course students read failed" | "assignment names read failed",
): Promise<NamedStudentsRead> {
  return readStudents(token, withActor, id, sql, failure, (rows) =>
    uniqueStudents(rows, namedStudentOf),
  );
}

const SQL =
  "SELECT student_id::text AS student_id, given_name, family_name FROM app.teacher_course_students($1::uuid)";

/** The students of one course for its teacher (T02, tab "Studenti"). */
export function readCourseStudents(
  sessionToken: string | undefined,
  withActor: WithActor,
  courseId: string,
): Promise<NamedStudentsRead> {
  return readNamedStudents(sessionToken, withActor, courseId, SQL, "course students read failed");
}

type GroupStudent = NamedStudent & { groupName: string | null };
type AssignmentWork = {
  assignmentId: string;
  documentId: string | null;
  workState: "not_started" | "in_progress" | "submitted";
};
type RosterStudent = GroupStudent & { assignments: AssignmentWork[] };
type EvidenceRecord = "continuous" | "with_gaps" | null;
type RevisionStatus = "open" | "responded" | "closed" | "withdrawn";
type OverviewFollowup = {
  noticeReadAt: string | null;
  noticeAcknowledged: { versionNo: number; acknowledgedAt: string } | null;
  revision: { state: RevisionStatus; changedAt: string } | null;
};
type OverviewStudent = GroupStudent &
  OverviewFollowup &
  (
    | { submitted: false; requestedMinute: null; afterDeadline: null; evidenceRecord: null }
    | {
        submitted: true;
        requestedMinute: string;
        afterDeadline: boolean;
        evidenceRecord: EvidenceRecord;
      }
  );

// Keep each authorized student, including one without a visible assignment.
// The overview and works readers enforce the work-level boundary separately
// from the course roster. All of the rows share one database snapshot.
const ROSTER_SQL = `WITH roster AS MATERIALIZED (
  SELECT * FROM app.teacher_course_students($1::uuid)
), works AS (
  SELECT overview.student_id, a.assignment_id, w.document_id, overview.evidence_record
    FROM app.teacher_course_assignment_ids($1::uuid) a
    CROSS JOIN LATERAL app.assignment_overview(a.assignment_id) overview
    LEFT JOIN LATERAL app.assignment_works(a.assignment_id) w ON w.student_id = overview.student_id
)
SELECT r.student_id::text AS student_id, r.given_name, r.family_name, r.group_name AS "groupName",
       w.assignment_id::text AS "assignmentId", w.document_id AS "documentId",
       w.evidence_record AS "evidenceRecord"
  FROM roster r LEFT JOIN works w ON w.student_id = r.student_id
 ORDER BY r.student_id, w.assignment_id`;

const OVERVIEW_SQL = `SELECT o.student_id::text AS student_id, o.given_name, o.family_name,
       o.group_name AS "groupName", o.submitted, o.requested_minute AS "requestedMinute",
       o.after_deadline AS "afterDeadline", o.evidence_record AS "evidenceRecord",
       f.notice_read_at AS "noticeReadAt", f.notice_ack_version AS "noticeAckVersion",
       f.notice_ack_at AS "noticeAckAt", f.revision_state AS "revisionState",
       f.revision_changed_at AS "revisionChangedAt"
  FROM app.assignment_overview($1::uuid) o
  JOIN app.assignment_overview_followup($1::uuid) f ON f.student_id = o.student_id
 ORDER BY o.student_id`;

function groupStudentOf(row: Row): GroupStudent | null {
  const student = namedStudentOf(row);
  const { groupName } = row;
  if (
    student === null ||
    (groupName !== null && (typeof groupName !== "string" || groupName === ""))
  ) {
    return null;
  }
  return { ...student, groupName };
}

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return value === null || value === "continuous" || value === "with_gaps";
}

function rosterOf(rows: Row[]): RosterStudent[] | null {
  const students = new Map<string, RosterStudent>();
  for (const row of rows) {
    const student = groupStudentOf(row);
    if (student === null) return null;
    const { studentId, givenName, familyName, groupName } = student;
    const { assignmentId, documentId, evidenceRecord } = row;
    let entry = students.get(studentId);
    const previous = entry?.assignments.at(-1);
    if (entry === undefined) {
      entry = { ...student, assignments: [] };
      students.set(studentId, entry);
    } else if (
      entry.givenName !== givenName ||
      entry.familyName !== familyName ||
      entry.groupName !== groupName ||
      previous === undefined
    ) {
      return null;
    }
    if (assignmentId === null) {
      if (previous !== undefined || documentId !== null || evidenceRecord !== null) return null;
      continue;
    }
    if (
      typeof assignmentId !== "string" ||
      !UUID.test(assignmentId) ||
      (previous !== undefined && previous.assignmentId >= assignmentId) ||
      (documentId !== null && !isWorkId(documentId)) ||
      !isEvidenceRecord(evidenceRecord)
    )
      return null;
    const workState =
      evidenceRecord !== null ? "submitted" : documentId === null ? "not_started" : "in_progress";
    entry.assignments.push({ assignmentId, documentId, workState });
  }
  return [...students.values()];
}

const REVISION_STATES: ReadonlySet<unknown> = new Set(["open", "responded", "closed", "withdrawn"]);

function instantOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  const iso = value.toISOString();
  return iso.length === 24 ? iso : undefined;
}

/** The notice and revision columns of one row, or null when they are not what the function returns. */
function followupOf(row: Row): OverviewFollowup | null {
  const { noticeAckVersion, revisionState } = row;
  const readAt = instantOf(row.noticeReadAt);
  const ackAt = instantOf(row.noticeAckAt);
  const changedAt = instantOf(row.revisionChangedAt);
  if (readAt === undefined || ackAt === undefined || changedAt === undefined) return null;
  let noticeAcknowledged: OverviewFollowup["noticeAcknowledged"] = null;
  if (noticeAckVersion === null || ackAt === null) {
    if (noticeAckVersion !== null || ackAt !== null) return null;
  } else {
    if (!Number.isInteger(noticeAckVersion) || (noticeAckVersion as number) < 1) return null;
    noticeAcknowledged = { versionNo: noticeAckVersion as number, acknowledgedAt: ackAt };
  }
  let revision: OverviewFollowup["revision"] = null;
  if (revisionState === null || changedAt === null) {
    if (revisionState !== null || changedAt !== null) return null;
  } else {
    if (!REVISION_STATES.has(revisionState)) return null;
    revision = { state: revisionState as RevisionStatus, changedAt };
  }
  return { noticeReadAt: readAt, noticeAcknowledged, revision };
}

function overviewStudentOf(row: Row): OverviewStudent | null {
  const base = groupStudentOf(row);
  const followup = followupOf(row);
  if (base === null || followup === null) return null;
  const student = { ...base, ...followup };
  const { submitted, requestedMinute, afterDeadline, evidenceRecord } = row;
  if (!isEvidenceRecord(evidenceRecord)) return null;
  if (
    submitted === false &&
    requestedMinute === null &&
    afterDeadline === null &&
    evidenceRecord === null
  ) {
    return { ...student, submitted, requestedMinute, afterDeadline, evidenceRecord };
  }
  if (
    submitted !== true ||
    typeof afterDeadline !== "boolean" ||
    !(requestedMinute instanceof Date) ||
    requestedMinute.getTime() % 60_000 !== 0
  )
    return null;
  const minute = requestedMinute.toISOString();
  if (minute.length !== 24) return null;
  return { ...student, submitted, requestedMinute: minute, afterDeadline, evidenceRecord };
}

export function readTeacherRoster(token: string, withActor: WithActor, courseId: string) {
  return readStudents(
    token,
    withActor,
    courseId,
    ROSTER_SQL,
    "course students read failed",
    rosterOf,
  );
}

export function readAssignmentOverview(token: string, withActor: WithActor, assignmentId: string) {
  return readStudents(
    token,
    withActor,
    assignmentId,
    OVERVIEW_SQL,
    "assignment overview read failed",
    (rows) => uniqueStudents(rows, overviewStudentOf),
  );
}
