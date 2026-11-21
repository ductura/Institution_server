import type { WithActor } from "../../database/index.ts";

// Materialize the authorization before calling the side-effecting live reader.
// The owner predicate binds the requested document to this assignment. The
// mentor predicate additionally requires an active teaching relation to this
// mentorship, which a course teacher or a delegated reader cannot satisfy.
const READ_SQL = `WITH actor AS MATERIALIZED (
  SELECT coalesce(institution_display_name, institution_slug) AS institution, display_name AS name
  FROM app.my_account()
), allowed AS MATERIALIZED (
  SELECT $2::text AS "documentId", v.title, actor.name AS student
  FROM actor
  JOIN institution.assignment a ON a.id = $1::uuid
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
  WHERE app.work_document_in_assignment($2, a.id)
  UNION ALL
  SELECT w.document_id, v.title, n.given_name || ' ' || n.family_name
  FROM actor
  JOIN institution.assignment a ON a.id = $1::uuid
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
  CROSS JOIN LATERAL app.assignment_works(a.id) w
  LEFT JOIN LATERAL app.teacher_assignment_names(a.id) n ON n.student_id = w.student_id
  WHERE a.mentorship_id IS NOT NULL AND institution.actor_mentorship_role(a.mentorship_id) = 'teacher'
    AND w.document_id = $2
)
SELECT actor.institution, source.title, source.student, source.outcome, source.hash, source.body
FROM actor LEFT JOIN LATERAL (
  SELECT allowed.title, allowed.student, live.outcome, live.content_hash AS hash, live.body
  FROM allowed CROSS JOIN LATERAL collaboration.read_live_state(allowed."documentId", NULL) live
) source ON true`;

export type PdfSource =
  | {
      status: "found";
      kind: "saved" | "submitted";
      hash: string;
      body: string;
      title: string;
      institution: string;
      student: string;
    }
  | { status: "unauthorized" | "not_found" | "unavailable" };

export type ReadPdfSource = (
  token: string,
  assignment: string,
  document: string,
) => Promise<PdfSource>;

export function readPdfSource(withActor: WithActor): ReadPdfSource {
  return async (token, assignment, document) => {
    try {
      const { rows } = await withActor(token, (tx) =>
        tx.query<Record<string, unknown>>(READ_SQL, [assignment, document]),
      );
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) return { status: "unavailable" };
      if (row.outcome === null || row.outcome === "empty") return { status: "not_found" };
      if (
        (row.outcome !== "state" && row.outcome !== "submitted") ||
        typeof row.institution !== "string" ||
        typeof row.title !== "string" ||
        (typeof row.student !== "string" && row.student !== null) ||
        typeof row.hash !== "string" ||
        typeof row.body !== "string"
      )
        return { status: "unavailable" };
      return {
        status: "found",
        kind: row.outcome === "submitted" ? "submitted" : "saved",
        hash: row.hash,
        body: row.body,
        title: row.title,
        institution: row.institution,
        student: row.student ?? "",
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthorized" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
  };
}
