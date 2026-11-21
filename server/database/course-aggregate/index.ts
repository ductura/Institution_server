import type { CourseAggregate } from "../../contracts/index.ts";

import type { WithActor } from "../index.ts";

// Use one snapshot for the actor, roster and work. The existing readers share
// the work access rules, including works started before the teacher joined.
// A missing submission-reader row means the work is outside the actor's scope.
const SQL = `
WITH actor AS MATERIALIZED (
  SELECT user_id, institution_id FROM app.current_actor()
), course AS MATERIALIZED (
  SELECT $1::uuid AS id, institution_id FROM actor
   WHERE institution.actor_course_role($1::uuid) = 'teacher'
), roster AS MATERIALIZED (
  SELECT m.user_id
    FROM course c JOIN institution.course_member m USING (institution_id)
   WHERE m.course_id = c.id AND m.role = 'student' AND m.member_to IS NULL
), assignments AS MATERIALIZED (
  SELECT a.assignment_id
    FROM course c
    CROSS JOIN LATERAL app.teacher_course_assignment_ids(c.id) a
   WHERE (SELECT count(*) FROM roster) >= 5
), visible_works AS (
  SELECT a.assignment_id, s.student_id, s.submitted, w.student_id IS NOT NULL AS started
    FROM assignments a
    CROSS JOIN LATERAL app.assignment_submissions(a.assignment_id) s
    LEFT JOIN LATERAL (
      SELECT DISTINCT student_id FROM app.assignment_works(a.assignment_id)
    ) w ON w.student_id = s.student_id
), students AS (
  SELECT r.user_id,
         coalesce(bool_or(w.submitted), false) AS submitted,
         coalesce(bool_or(w.started OR w.submitted), false) AS started,
         count(w.assignment_id) = (SELECT count(*) FROM assignments) AS covered
    FROM roster r LEFT JOIN visible_works w ON w.student_id = r.user_id
   GROUP BY r.user_id
)
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM actor WHERE user_id IS NOT NULL AND institution_id IS NOT NULL)
           THEN 'unauthenticated'
         WHEN NOT EXISTS (SELECT 1 FROM course) THEN 'not_found'
         ELSE 'ok'
       END AS status,
       coalesce(bool_and(covered), true) AS covered,
       count(*) FILTER (WHERE NOT started)::int AS "notStarted",
       count(*) FILTER (WHERE started AND NOT submitted)::int AS "inProgress",
       count(*) FILTER (WHERE submitted)::int AS submitted
  FROM students`;

type Row = {
  status: unknown;
  covered: unknown;
  notStarted: unknown;
  inProgress: unknown;
  submitted: unknown;
};
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const MIN_STUDENTS = 5;

export function createCourseAggregateReader(withActor: WithActor) {
  return async (
    token: string,
    id: string,
  ): Promise<CourseAggregate | { status: "unauthenticated" | "not_found" }> => {
    const { rows } = await withActor(token, (tx) => tx.query<Row>(SQL, [id]));
    if (rows.length !== 1) throw new Error("course aggregate: expected one row");
    const { status, covered, notStarted, inProgress, submitted } = rows[0]!;
    if (status === "unauthenticated" || status === "not_found") return { status };
    if (
      status !== "ok" ||
      typeof covered !== "boolean" ||
      !isCount(notStarted) ||
      !isCount(inProgress) ||
      !isCount(submitted)
    ) {
      throw new Error("course aggregate: invalid row");
    }
    const started = inProgress + submitted;
    const partition = [notStarted, inProgress, submitted];
    // Every nonempty difference between the published counts is a union of
    // whole stages. Hide the entire partition if even one stage is too small.
    if (
      !covered ||
      notStarted + started < MIN_STUDENTS ||
      partition.some((count) => count > 0 && count < MIN_STUDENTS)
    ) {
      return { status: "suppressed" };
    }
    return {
      status: "available",
      started,
      submitted,
      stages: { not_started: notStarted, in_progress: inProgress, submitted },
    };
  };
}
