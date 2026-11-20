// The teacher's two reads of wave 4 (SRV-13, Ductus#2028 c.7008147932):
// teacher.courses.get and teacher.access.get. Ports of Ductus 4eaa776
// src/server/institution/teacher-courses.ts (readTeacherCourses, coursesOf)
// and src/components/teacher/teacher-access.ts (teacherPageRead), one
// withActor transaction and one statement each. Who asks comes only from the
// session token inside app.current_actor(), never from a parameter; the
// database decides which courses (institution.list_teacher_courses under RLS).
// ZD401 is `unauthenticated`; any other failure, or a row that is not what the
// statement returns, is thrown on and the route answers it as 503.
import type { WithActor } from "./with-actor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACADEMIC_YEAR = /^[0-9]{4}\/[0-9]{4}$/;
const AI_POLICIES = ["prohibited", "partially_allowed", "encouraged"] as const;
const WORK_TYPES = [
  ...["short_paper", "essay", "seminar_paper", "bachelor_thesis", "master_thesis"],
  ...["specialist_thesis", "doctoral_thesis"],
] as const;

export type TeacherAssignment = {
  readonly id: string;
  readonly title: string;
  readonly workType: (typeof WORK_TYPES)[number];
  readonly opensAt: string;
  readonly dueAt: string;
  readonly currentVersion: number;
  readonly enrolledStudents: number;
};

export type TeacherCourse = {
  readonly id: string;
  readonly name: string;
  readonly academicYear: string;
  readonly aiPolicy: (typeof AI_POLICIES)[number];
  readonly assignments: TeacherAssignment[];
};

export type TeacherCoursesResult =
  | { readonly ok: true; readonly courses: readonly TeacherCourse[] }
  | { readonly ok: false; readonly reason: "unauthenticated" | "not_found" };
export type TeacherCoursesReader = (token: string) => Promise<TeacherCoursesResult>;

export type TeacherAccessResult =
  | {
      readonly ok: true;
      readonly access: "allowed" | "denied";
      readonly userId: string;
      readonly institutionId: string;
    }
  | { readonly ok: false; readonly reason: "unauthenticated" };
export type TeacherAccessReader = (token: string) => Promise<TeacherAccessResult>;

type Row = Record<string, unknown>;

// Academic year descending, then name; assignments by due time, then title
// (Croatian collation); the id breaks any tie, so the order never wavers. A
// course without an assignment is one row with a null assignment.
const COURSES_SQL = `SELECT course_id::text AS "courseId", course_name AS "courseName",
       academic_year AS "academicYear", ai_policy AS "aiPolicy",
       assignment_id::text AS "assignmentId", title, work_type AS "workType",
       opens_at AS "opensAt", due_at AS "dueAt", current_version AS "currentVersion",
       enrolled_students AS "enrolledStudents"
  FROM institution.list_teacher_courses()
 ORDER BY academic_year DESC, course_name COLLATE "hr-x-icu", course_id,
          due_at, title COLLATE "hr-x-icu", assignment_id`;

const ACCESS_SQL = `SELECT a.user_id::text AS "userId", a.institution_id::text AS "institutionId",
       institution.actor_has_role('teacher') AS allowed
  FROM app.current_actor() a`;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;
const isCount = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const instant = (value: unknown): string | null =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;

function malformed(): never {
  throw new Error("teacherCourses: malformed row");
}

/**
 * The rows, in the statement's order, as the contract's courses; throws on
 * any row that is not what the function returns.
 */
export function teacherCoursesOf(rows: readonly Row[]): TeacherCourse[] {
  const courses = new Map<string, TeacherCourse>();
  for (const row of rows) {
    const { courseId: id, courseName: name, academicYear: year, aiPolicy: policy } = row;
    if (
      typeof id !== "string" ||
      !UUID.test(id) ||
      typeof name !== "string" ||
      name === "" ||
      typeof year !== "string" ||
      !ACADEMIC_YEAR.test(year) ||
      !oneOf(AI_POLICIES, policy)
    )
      malformed();
    let course = courses.get(id);
    if (course === undefined) {
      course = { id, name, academicYear: year, aiPolicy: policy, assignments: [] };
      courses.set(id, course);
    } else if (course.name !== name || course.academicYear !== year || course.aiPolicy !== policy) {
      malformed();
    }
    if (row.assignmentId === null) continue;
    const opensAt = instant(row.opensAt);
    const dueAt = instant(row.dueAt);
    if (
      typeof row.assignmentId !== "string" ||
      !UUID.test(row.assignmentId) ||
      typeof row.title !== "string" ||
      row.title === "" ||
      !oneOf(WORK_TYPES, row.workType) ||
      opensAt === null ||
      dueAt === null ||
      !isCount(row.currentVersion, 1) ||
      !isCount(row.enrolledStudents, 0)
    )
      malformed();
    course.assignments.push({
      id: row.assignmentId,
      title: row.title,
      workType: row.workType,
      opensAt,
      dueAt,
      currentVersion: row.currentVersion,
      enrolledStudents: row.enrolledStudents,
    });
  }
  return [...courses.values()];
}

export function createTeacherCoursesReader(withActor: WithActor): TeacherCoursesReader {
  return async (token) => {
    let rows: Row[];
    try {
      rows = await withActor(token, async (tx) => (await tx.query<Row>(COURSES_SQL)).rows);
    } catch (error) {
      if (codeOf(error) === "ZD401") return { ok: false, reason: "unauthenticated" };
      if (codeOf(error) === "ZD403") return { ok: false, reason: "not_found" };
      throw error;
    }
    return { ok: true, courses: teacherCoursesOf(rows) };
  };
}

/**
 * The session and the role from one snapshot (Ductus teacherPageRead): denied
 * is always an open session without the role, allowed always comes with a
 * signed-in principal (the route makes its scope). No actor is `unauthenticated`.
 */
export function createTeacherAccessReader(withActor: WithActor): TeacherAccessReader {
  return async (token) => {
    const rows = await withActor(token, async (tx) => (await tx.query<Row>(ACCESS_SQL)).rows);
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) throw new Error("teacherAccess: malformed row");
    if (row.userId === null || row.institutionId === null) {
      return { ok: false, reason: "unauthenticated" };
    }
    if (
      typeof row.userId !== "string" ||
      !UUID.test(row.userId) ||
      typeof row.institutionId !== "string" ||
      !UUID.test(row.institutionId) ||
      typeof row.allowed !== "boolean"
    ) {
      throw new Error("teacherAccess: malformed row");
    }
    return {
      ok: true,
      access: row.allowed ? "allowed" : "denied",
      userId: row.userId,
      institutionId: row.institutionId,
    };
  };
}
