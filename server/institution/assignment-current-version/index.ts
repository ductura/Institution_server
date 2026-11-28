import type { WithActor } from "../../database/index.ts";

// One statement uses the same snapshot for the teacher relation, the current
// pointer and its content. RLS also applies to both assignment tables.
const SELECT_CURRENT = `
  SELECT a.id AS "assignmentId", a.course_id AS "courseId", v.version_no AS "versionNo",
         a.is_practice AS "isPractice", a.external_tools_allowed AS "externalToolsAllowed",
         a.ai_summary_only AS "aiSummaryOnly",
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

// F4 wave 2 #5 (1.8): the course's groups the assignment is for, read in the
// same transaction once the caller is known to teach its course. The function
// asks the same relation (require_course_teacher, actor_course_role), so it
// refuses nobody the read above let through.
const SELECT_GROUPS = "SELECT group_id FROM institution.assignment_groups($1::uuid)";
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type CurrentVersionRead =
  | { kind: "found"; body: Record<string, unknown> }
  | { kind: "unauthorized" }
  | { kind: "not_found" };

export async function readAssignmentCurrentVersion(
  withActor: WithActor,
  token: string,
  assignmentId: string,
): Promise<CurrentVersionRead> {
  const { rows, groups } = await withActor(token, async (tx) => {
    const current = await tx.query<Record<string, unknown>>(SELECT_CURRENT, [assignmentId]);
    // A mentorship's assignment has no course, so no groups (and the function's ZD403).
    const row = current.rows.length === 1 ? current.rows[0]! : undefined;
    const found = row?.assignmentId === assignmentId && typeof row.courseId === "string";
    const linked = found ? (await tx.query(SELECT_GROUPS, [assignmentId])).rows : [];
    return { rows: current.rows, groups: linked.map((link) => link.group_id as unknown) };
  });
  if (rows.length === 0) return { kind: "unauthorized" };
  if (rows.length !== 1) throw new Error("unexpected current assignment row count");
  const { assignmentId: resultId, opensAt, dueAt, ...fields } = rows[0]!;
  if (resultId === null) return { kind: "not_found" };
  if (resultId !== assignmentId || !(opensAt instanceof Date) || !(dueAt instanceof Date)) {
    throw new Error("malformed current assignment row");
  }
  if (!groups.every((id): id is string => typeof id === "string" && LOWER_UUID.test(id))) {
    throw new Error("malformed assignment group row");
  }
  return {
    kind: "found",
    body: {
      ...fields,
      assignmentId: resultId,
      opensAt: opensAt.toISOString(),
      dueAt: dueAt.toISOString(),
      // Absent for the whole course, as the creation takes it.
      ...(groups.length === 0 ? {} : { groupIds: groups }),
    },
  };
}
