// The teacher's courses and their assignments (contract teacher.courses.get).
// Port of Ductus src/server/institution/teacher-courses.ts at 078c780
// (coursesOf and readTeacherCourses) without a change of logic; changes are of
// form: the token's shape is the route's (liveSessionTokenFromCookie), a
// failure is an outcome whose reason names no SQLSTATE and nothing is logged
// here, and the Croatian collation is String.prototype.localeCompare(…, "hr"),
// the same comparison as Intl.Collator("hr").compare (server code may not
// name Intl, lint local/no-hardcoded-text). Who asks comes only from the
// session bound into withActor; the database decides which courses
// (institution.list_teacher_courses, under the existing RLS). The answer
// names no student, text or time of the live view: per assignment only the
// number of students of the course.
import type { WithActor } from "./with-actor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACADEMIC_YEAR = /^[0-9]{4}\/[0-9]{4}$/;
/** The three rules a course can have (institution.course.ai_policy). */
const AI_POLICIES = new Set(["prohibited", "partially_allowed", "encouraged"]);
export type CourseAiPolicy = "prohibited" | "partially_allowed" | "encouraged";
const WORK_TYPES = new Set([
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
]);

export type TeacherAssignment = {
  id: string;
  title: string;
  workType: string;
  opensAt: string;
  dueAt: string;
  currentVersion: number;
  enrolledStudents: number;
};

export type TeacherCourse = {
  id: string;
  name: string;
  academicYear: string;
  aiPolicy: CourseAiPolicy;
  assignments: TeacherAssignment[];
};

/** ZD401 unauthenticated, ZD403 not_found (Ductus), anything else unavailable. */
export type TeacherCoursesOutcome =
  | { readonly status: "ok"; readonly courses: readonly TeacherCourse[] }
  | { readonly status: "unauthenticated" | "not_found" }
  | { readonly status: "unavailable"; readonly reason: string };

export type TeacherCoursesReader = (token: string) => Promise<TeacherCoursesOutcome>;

type Row = Record<string, unknown>;

const SQL = `SELECT course_id::text, course_name, academic_year, assignment_id::text, title, work_type,
                opens_at, due_at, current_version, enrolled_students, ai_policy
           FROM institution.list_teacher_courses()`;

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

const isCount = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;

function instant(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Croatian collation, as Ductus Intl.Collator("hr").compare. */
const collate = (a: string, b: string): number => a.localeCompare(b, "hr");

/** The rows as the contract's courses, or null when any row is not what the function returns. */
export function coursesOf(rows: readonly Row[]): TeacherCourse[] | null {
  const courses = new Map<string, TeacherCourse>();
  for (const row of rows) {
    const { course_id: id, course_name: name, academic_year: year, ai_policy: policy } = row;
    if (
      typeof id !== "string" ||
      !UUID.test(id) ||
      typeof name !== "string" ||
      name === "" ||
      typeof year !== "string" ||
      !ACADEMIC_YEAR.test(year) ||
      typeof policy !== "string" ||
      !AI_POLICIES.has(policy)
    ) {
      return null;
    }
    const aiPolicy = policy as CourseAiPolicy;
    let course = courses.get(id);
    if (course === undefined) {
      course = { id, name, academicYear: year, aiPolicy, assignments: [] };
      courses.set(id, course);
    } else if (
      course.name !== name ||
      course.academicYear !== year ||
      course.aiPolicy !== aiPolicy
    ) {
      return null;
    }
    if (row.assignment_id === null) continue;
    const opensAt = instant(row.opens_at);
    const dueAt = instant(row.due_at);
    if (
      typeof row.assignment_id !== "string" ||
      !UUID.test(row.assignment_id) ||
      typeof row.title !== "string" ||
      row.title === "" ||
      typeof row.work_type !== "string" ||
      !WORK_TYPES.has(row.work_type) ||
      opensAt === null ||
      dueAt === null ||
      !isCount(row.current_version, 1) ||
      !isCount(row.enrolled_students, 0)
    ) {
      return null;
    }
    course.assignments.push({
      id: row.assignment_id,
      title: row.title,
      workType: row.work_type,
      opensAt,
      dueAt,
      currentVersion: row.current_version,
      enrolledStudents: row.enrolled_students,
    });
  }
  // Academic year descending, then name; assignments by due time, then title
  // (Croatian collation); the id breaks any tie, so the order never wavers.
  const list = [...courses.values()];
  for (const course of list) {
    course.assignments.sort(
      (a, b) =>
        Date.parse(a.dueAt) - Date.parse(b.dueAt) ||
        collate(a.title, b.title) ||
        (a.id < b.id ? -1 : 1),
    );
  }
  return list.sort(
    (a, b) =>
      b.academicYear.localeCompare(a.academicYear) ||
      collate(a.name, b.name) ||
      (a.id < b.id ? -1 : 1),
  );
}

export function createTeacherCoursesReader(withActor: WithActor): TeacherCoursesReader {
  return async (token) => {
    let rows: Row[];
    try {
      rows = (await withActor(token, (tx) => tx.query<Row>(SQL))).rows;
    } catch (thrown) {
      const code = codeOf(thrown);
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable", reason: "database_error" };
    }
    const courses = coursesOf(rows);
    return courses === null
      ? { status: "unavailable", reason: "row_malformed" }
      : { status: "ok", courses };
  };
}
