import type { WithActor } from "../database/index.ts";

const NOTE_FIELDS = 'id, text, created_at AS "createdAt"';
const READ_NOTES = `SELECT ${NOTE_FIELDS} FROM app.submission_notes($1::uuid) ORDER BY created_at, id`;
const ADD_NOTE = `SELECT ${NOTE_FIELDS} FROM app.add_submission_note($1::uuid, $2::text)`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type SubmissionNote = { id: string; text: string; createdAt: string };
type SubmissionNoteRow = { id: unknown; text: unknown; createdAt: unknown };
type NoteInput = { assignmentId: string; text: string };
type AccessRefusal = { status: "unauthorized" | "not_found" };
type ReadNotes = { status: "read"; notes: SubmissionNote[] } | AccessRefusal;
type AddNote =
  { status: "added"; note: SubmissionNote } | AccessRefusal | { status: "invalid_input" };

function isSubmissionNoteId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && LOWER_UUID.test(value);
}

function isSubmissionNoteText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !value.includes("\u0000") &&
    Array.from(value).length <= 600
  );
}

function noteInputOf(value: unknown): NoteInput | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "assignmentId") ||
    !Object.hasOwn(value, "text")
  ) {
    return undefined;
  }
  const { assignmentId, text } = value as Record<string, unknown>;
  if (!isSubmissionNoteId(assignmentId) || !isSubmissionNoteText(text)) return undefined;
  return { assignmentId, text };
}

function noteOf({ id, text, createdAt }: SubmissionNoteRow): SubmissionNote {
  if (
    !isSubmissionNoteId(id) ||
    !isSubmissionNoteText(text) ||
    !(createdAt instanceof Date) ||
    !Number.isFinite(createdAt.getTime())
  ) {
    throw new Error("invalid submission note row");
  }
  const instant = createdAt.toISOString();
  if (instant.length !== 24) throw new Error("invalid submission note timestamp");
  return { id, text, createdAt: instant };
}

function accessRefusal(code: unknown): AccessRefusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

function sqlState(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** The session alone names the student, including on reads. */
export function createStudentNotes(withActor: WithActor) {
  return {
    async read(token: string, assignmentId: string): Promise<ReadNotes> {
      if (!isSubmissionNoteId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<SubmissionNoteRow>(READ_NOTES, [assignmentId]);
          return { status: "read", notes: rows.map(noteOf) };
        });
      } catch (error) {
        const refusal = accessRefusal(sqlState(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    async add(token: string, body: unknown): Promise<AddNote> {
      const input = noteInputOf(body);
      if (input === undefined) return { status: "invalid_input" };
      const { assignmentId, text } = input;
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<SubmissionNoteRow>(ADD_NOTE, [assignmentId, text]);
          const row = rows[0];
          // Confirm the saved result inside the transaction so a malformed result rolls back.
          if (rows.length !== 1 || row?.text !== text)
            throw new Error("unconfirmed submission note");
          return { status: "added", note: noteOf(row) };
        });
      } catch (error) {
        const code = sqlState(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = accessRefusal(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}
