import type { WithActor } from "../../database/index.ts";

// Keep the relationship check and every source in one statement snapshot.
// The deadline projections both call institution.effective_due_at, which is
// intentionally private to the database owner.
const SQL = `
WITH actor AS MATERIALIZED (
  SELECT user_id, institution_id FROM app.current_actor()
   WHERE user_id IS NOT NULL AND institution_id IS NOT NULL
), scope AS MATERIALIZED (
  SELECT m.id, m.student_id, m.institution_id,
         institution.actor_mentorship_role(m.id) AS role
    FROM actor c
    JOIN institution.mentorship m ON m.institution_id = c.institution_id
   WHERE m.id = $1::uuid AND m.ended_at IS NULL
     AND c.user_id IN (m.student_id, m.mentor_id)
), work AS MATERIALIZED (
  SELECT s.student_id, a.id AS assignment_id,
         CASE s.role
           WHEN 'student' THEN app.student_effective_due_at(a.id)
           WHEN 'teacher' THEN (
             SELECT o.due_at FROM app.assignment_overview(a.id) o WHERE o.student_id = s.student_id
           )
         END AS due_at,
         CASE s.role
           WHEN 'student' THEN (
             SELECT d.id
               FROM evidence.project p
               JOIN evidence.document d ON d.project_id = p.id
                AND d.institution_id = p.institution_id AND d.principal_id = p.principal_id
              WHERE p.assignment_id = a.id AND p.institution_id = s.institution_id
                AND p.principal_id = s.student_id
           )
           WHEN 'teacher' THEN (
             SELECT w.document_id FROM app.assignment_works(a.id) w WHERE w.student_id = s.student_id
           )
         END AS document_id
    FROM scope s
    JOIN institution.assignment a ON a.mentorship_id = s.id AND a.institution_id = s.institution_id
   WHERE s.role IN ('student', 'teacher')
), document AS MATERIALIZED (
  SELECT document_id FROM work WHERE document_id IS NOT NULL
), dates AS (
  SELECT 'deadline' AS kind, assignment_id AS id, due_at AS at, NULL::text AS title, NULL::text AS state
    FROM work WHERE due_at IS NOT NULL
  UNION ALL
  SELECT 'milestone', m.id, m.due_at, m.title, NULL::text
    FROM document d CROSS JOIN LATERAL app.read_work_milestones(d.document_id) m
   WHERE m.due_at IS NOT NULL
  UNION ALL
  SELECT 'consultation', s.id, s.starts_at, NULL::text, s.state
    FROM document d CROSS JOIN LATERAL institution.consultation_slots(d.document_id) s
)
SELECT access.authenticated, access.visible, dates.*
  FROM (SELECT EXISTS (SELECT FROM actor) AS authenticated,
               EXISTS (SELECT FROM scope WHERE role IN ('student', 'teacher')) AS visible) access
  LEFT JOIN dates ON true
 ORDER BY dates.at, dates.kind, dates.id`;

type DateRow = {
  authenticated: boolean;
  visible: boolean;
} & (
  | { kind: null }
  | { kind: string; id: string; at: Date; title: string | null; state: string | null }
);

export async function readKeyDates(withActor: WithActor, token: string, id: string) {
  return withActor(token, async (tx) => {
    const { rows } = await tx.query<DateRow>(SQL, [id]);
    const [access] = rows;
    if (access === undefined) throw new Error("missing key dates access result");
    if (!access.authenticated) return { status: "unauthorized" } as const;
    if (!access.visible) return { status: "not_found" } as const;

    const dates = rows
      .filter((row) => row.kind !== null)
      .map(({ kind, id, at, title, state }) => ({
        kind,
        id,
        at: at.toISOString(),
        ...(kind === "milestone" ? { title } : {}),
        ...(kind === "consultation" ? { state } : {}),
      }));
    return { status: "ok", body: { dates } } as const;
  });
}
