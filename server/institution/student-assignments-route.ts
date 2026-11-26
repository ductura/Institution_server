// SRV-09 (Ductus#2028 c.7008147932): the body of student.assignments.get from
// the rows of institution.student_assignments() (SRV-08). The rows come one per
// assignment, already in the contract's order (the port sorts them by course
// name in Croatian collation, course id, due time and id, since server code
// may not collate text itself); here they become courses in that order.
// noticeFirst is true while the current version's notice is not acknowledged.
// A work type the contract does not name makes the whole answer unavailable,
// never a partial list. groups, teachers and mentor are left out until the
// read gives them in the contract's shape (Ductus#2028 c.7009610321); the
// contract has them optional, so the answer stays valid.
import type { StudentAssignmentRow } from "../database/index.ts";

export const WORK_TYPES: ReadonlySet<string> = new Set([
  ...["short_paper", "essay", "seminar_paper", "bachelor_thesis", "master_thesis"],
  ...["specialist_thesis", "doctoral_thesis"],
]);

export type StudentAssignment = {
  id: string;
  title: string;
  dueAt: string;
  noticeFirst: boolean;
  workType: string;
  extendedDueAt: string | null;
  isPractice: boolean;
};
export type StudentCourse = {
  id: string;
  name: string;
  academicYear: string;
  assignments: StudentAssignment[];
};

/** The courses of the rows, or null when a row has a work type the contract does not name. */
export function studentCoursesOf(rows: readonly StudentAssignmentRow[]): StudentCourse[] | null {
  const courses = new Map<string, StudentCourse>();
  for (const row of rows) {
    if (!WORK_TYPES.has(row.workType)) return null;
    let course = courses.get(row.courseId);
    if (course === undefined) {
      course = {
        id: row.courseId,
        name: row.courseName,
        academicYear: row.academicYear,
        assignments: [],
      };
      courses.set(row.courseId, course);
    }
    course.assignments.push({
      id: row.assignmentId,
      title: row.title,
      dueAt: row.dueAt,
      noticeFirst: !row.acknowledged,
      workType: row.workType,
      extendedDueAt: row.extendedDueAt,
      isPractice: row.isPractice,
    });
  }
  return [...courses.values()];
}
