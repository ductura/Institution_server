// SRV-F4-NAS-R11 (NAS-51, C-4): the notes a student kept beside a submission,
// read by a teacher or the mentor. app.submission_notes (20261120090000)
// checks the relationship; every refusal (ZD403) is the same 404 as an unknown
// id. The caller's own notes are never read here: the student is always named,
// and a student naming themself is refused by the database (they are no reader).
import type { WithActor } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQL = `SELECT id, text, created_at AS "createdAt"
    FROM app.submission_notes($1::uuid, $2::uuid) ORDER BY created_at, id`;

export type TeacherSubmissionNote = { id: string; text: string; createdAt: string };

export type TeacherSubmissionNotesReader = (
  token: string,
  assignmentId: string,
  studentId: string,
) => Promise<
  | { status: "ok"; body: { notes: TeacherSubmissionNote[] } }
  | { status: "unauthenticated" | "not_found" | "unavailable" }
>;

export function createTeacherSubmissionNotesReader(
  withActor: WithActor,
): TeacherSubmissionNotesReader {
  return async (token, assignmentId, studentId) => {
    assignmentId = assignmentId.toLowerCase();
    studentId = studentId.toLowerCase();
    if (!UUID.test(assignmentId) || !UUID.test(studentId)) return { status: "not_found" };

    let rows: Record<string, unknown>[];
    try {
      rows = await withActor(
        token,
        async (tx) =>
          (await tx.query<Record<string, unknown>>(SQL, [assignmentId, studentId])).rows,
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
    const notes: TeacherSubmissionNote[] = [];
    for (const row of rows) {
      const { id, text, createdAt } = row;
      if (typeof id !== "string" || typeof text !== "string" || !(createdAt instanceof Date)) {
        return { status: "unavailable" };
      }
      if (!Number.isFinite(createdAt.getTime())) return { status: "unavailable" };
      // The shapes are checked against the contract at the HTTP edge.
      notes.push({ id, text, createdAt: createdAt.toISOString() });
    }
    return { status: "ok", body: { notes } };
  };
}
