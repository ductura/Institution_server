import { createLiveStates, submissionOf, type WithActor } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// All metadata comes from one snapshot. The existing relationships authorize
// both the student of the assignment and the teacher's access to the work.
const SQL = `SELECT s.student_id, w.document_id, s.submitted, s.revision::text AS revision,
         s.requested_minute, s.after_deadline
    FROM app.teacher_submission_state($1::uuid, $2::uuid) p
    JOIN app.assignment_submissions($1::uuid) s
      ON s.student_id = $2::uuid AND s.revision = p.revision
    JOIN app.assignment_works($1::uuid) w USING (student_id)
   WHERE p.state IN ('ceka', 'potvrdeno') AND s.submitted`;

type SubmissionDetail = {
  studentId: string;
  revision: number;
  late: boolean;
  document: string;
};

export type TeacherSubmissionReader = (
  token: string,
  assignmentId: string,
  studentId: string,
) => Promise<
  | { status: "ok"; body: SubmissionDetail }
  | { status: "unauthenticated" | "not_found" | "unavailable" }
>;

export function createTeacherSubmissionReader(withActor: WithActor): TeacherSubmissionReader {
  const live = createLiveStates(withActor);
  return async (token, assignmentId, studentId) => {
    assignmentId = assignmentId.toLowerCase();
    studentId = studentId.toLowerCase();
    if (!UUID.test(assignmentId) || !UUID.test(studentId)) return { status: "not_found" };

    let rows: Record<string, unknown>[];
    try {
      rows = (
        await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(SQL, [assignmentId, studentId]),
        )
      ).rows;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
    if (rows.length === 0) return { status: "not_found" };
    const row = rows.length === 1 ? submissionOf(rows[0]!) : null;
    if (
      row === null ||
      row.studentId !== studentId ||
      row.documentId === null ||
      row.revision === null ||
      row.afterDeadline === null
    ) {
      return { status: "unavailable" };
    }

    // This repeats the relationship check and logs the opening. It validates
    // the bytes against the hash of the recorded submission in PostgreSQL.
    const content = await live.read(token, row.documentId, null);
    if (content.status === "not_found" || content.status === "unauthenticated") {
      return { status: content.status };
    }
    if (content.status !== "state" || !content.submitted) return { status: "unavailable" };
    return {
      status: "ok",
      body: {
        studentId,
        revision: row.revision,
        late: row.afterDeadline,
        document: Buffer.from(content.bytes).toString("utf8"),
      },
    };
  };
}
