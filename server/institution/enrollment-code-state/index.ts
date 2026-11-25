import type { WithActor } from "../../database/index.ts";

// One statement reads the teacher relation and the active code in the same
// snapshot. RLS applies to both tables, and ductus_app may not select
// code_hash, so the code itself can never be read here (A-8). The unique
// index course_enrollment_code_active_idx keeps at most one active code.
const SELECT_STATE = `
  SELECT c.id AS "courseId", e.valid_until AS "validUntil"
    FROM app.current_actor() actor
    LEFT JOIN institution.course c
      ON c.id = $1::uuid AND institution.actor_course_role(c.id) = 'teacher'
    LEFT JOIN institution.course_enrollment_code e
      ON e.course_id = c.id AND e.active
   WHERE actor.user_id IS NOT NULL
`;

export type EnrollmentCodeStateRead =
  | { kind: "found"; body: { current: { validUntil: string } | null } }
  | { kind: "unauthorized" }
  | { kind: "not_found" };

/**
 * Whether the course has a current enrolment code, for a teacher of the
 * course (contract institution.enrollment-code-state.get). No session row is
 * unauthorized; another institution's course, an unknown one and any caller
 * who is not a teacher of it are the same not_found (C-23). A row of any other
 * form throws, and the route answers 503.
 */
export async function readEnrollmentCodeState(
  withActor: WithActor,
  token: string,
  courseId: string,
): Promise<EnrollmentCodeStateRead> {
  const { rows } = await withActor(token, (tx) =>
    tx.query<Record<string, unknown>>(SELECT_STATE, [courseId]),
  );
  if (rows.length === 0) return { kind: "unauthorized" };
  if (rows.length !== 1) throw new Error("unexpected enrolment code state row count");
  const { courseId: resultId, validUntil } = rows[0]!;
  if (resultId === null) return { kind: "not_found" };
  if (resultId !== courseId) throw new Error("malformed enrolment code state row");
  if (validUntil === null) return { kind: "found", body: { current: null } };
  if (!(validUntil instanceof Date) || Number.isNaN(validUntil.getTime())) {
    throw new Error("malformed enrolment code state row");
  }
  return { kind: "found", body: { current: { validUntil: validUntil.toISOString() } } };
}
