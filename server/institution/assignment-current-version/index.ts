import type { WithActor } from "../../database/index.ts";

// One statement uses the same snapshot for the teacher relation, the current
// pointer and its content. RLS also applies to both assignment tables.
const SELECT_CURRENT = `
  SELECT a.id AS "assignmentId", a.course_id AS "courseId", v.version_no AS "versionNo",
         a.is_practice AS "isPractice",
         v.title, v.instructions, v.work_type AS "workType",
         v.opens_at AS "opensAt", v.due_at AS "dueAt", v.ai_policy AS "aiPolicy",
         v.ai_purposes AS "aiPurposes", v.evidence_profile AS "evidenceProfile",
         v.import_allowed AS "importAllowed", v.word_min AS "wordMin", v.word_max AS "wordMax"
    FROM app.current_actor() actor
    LEFT JOIN institution.assignment a
      ON a.id = $1::uuid AND institution.actor_assignment_role(a.id) = 'teacher'
    LEFT JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE actor.user_id IS NOT NULL
`;

type CurrentVersionRead =
  | { kind: "found"; body: Record<string, unknown> }
  | { kind: "unauthorized" }
  | { kind: "not_found" };

export async function readAssignmentCurrentVersion(
  withActor: WithActor,
  token: string,
  assignmentId: string,
): Promise<CurrentVersionRead> {
  const { rows } = await withActor(token, (tx) =>
    tx.query<Record<string, unknown>>(SELECT_CURRENT, [assignmentId]),
  );
  if (rows.length === 0) return { kind: "unauthorized" };
  if (rows.length !== 1) throw new Error("unexpected current assignment row count");
  const { assignmentId: resultId, opensAt, dueAt, ...fields } = rows[0]!;
  if (resultId === null) return { kind: "not_found" };
  if (resultId !== assignmentId || !(opensAt instanceof Date) || !(dueAt instanceof Date)) {
    throw new Error("malformed current assignment row");
  }
  return {
    kind: "found",
    body: {
      ...fields,
      assignmentId: resultId,
      opensAt: opensAt.toISOString(),
      dueAt: dueAt.toISOString(),
    },
  };
}
