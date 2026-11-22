// SRV-2003 (Ductus#2052): the database port of the teacher's read of one work
// by its document id (20261212100000, app.teacher_work_get). One withActor
// transaction over one RPC, which decides whether the caller may read the work:
// a work it does not name (not yours, not there, no relation) gives no row and
// the answer is one not_found (C-23). ZD401 is unauthenticated, anything else
// unavailable. A row of an unexpected shape is unavailable too. Nothing here
// reads the text of the work or writes anything.
import type { WithActor } from "../index.ts";

export const TEACHER_WORK_STATES = ["predano", "nije_predano", "nakon_roka", "ceka"] as const;
export type TeacherWorkState = (typeof TEACHER_WORK_STATES)[number];

export type TeacherWorkRead = {
  readonly documentId: string;
  readonly studentId: string;
  /** Given and family name; null when the account has no name pair. */
  readonly studentName: string | null;
  readonly assignmentId: string;
  readonly state: TeacherWorkState;
  readonly prevDocumentId: string | null;
  readonly nextDocumentId: string | null;
};

export type TeacherWorkOutcome =
  | { readonly status: "ok"; readonly work: TeacherWorkRead }
  | { readonly status: "unauthenticated" | "not_found" | "unavailable" };

export type TeacherWork = {
  get(token: string, documentId: string): Promise<TeacherWorkOutcome>;
};

const SQL =
  "SELECT document_id, student_id::text AS student_id, given_name, family_name, assignment_id::text AS assignment_id, state, prev_document_id, next_document_id FROM app.teacher_work_get($1)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function idOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length >= 1 && value.length <= 256) return value;
  throw new Malformed();
}

function nameOf(given: unknown, family: unknown): string | null {
  if (given === null && family === null) return null;
  if (typeof given !== "string" || typeof family !== "string") throw new Malformed();
  const name = `${given} ${family}`.trim();
  return name === "" ? null : name.slice(0, 256);
}

function toWork(row: Record<string, unknown>): TeacherWorkRead {
  const { student_id: studentId, assignment_id: assignmentId, state } = row;
  const known = TEACHER_WORK_STATES.find((candidate) => candidate === state);
  const documentId = idOrNull(row.document_id);
  if (
    documentId === null ||
    known === undefined ||
    typeof studentId !== "string" ||
    !UUID.test(studentId) ||
    typeof assignmentId !== "string" ||
    !UUID.test(assignmentId)
  ) {
    throw new Malformed();
  }
  return {
    documentId,
    studentId,
    studentName: nameOf(row.given_name, row.family_name),
    assignmentId,
    state: known,
    prevDocumentId: idOrNull(row.prev_document_id),
    nextDocumentId: idOrNull(row.next_document_id),
  };
}

export function createTeacherWork(withActor: WithActor): TeacherWork {
  return {
    async get(token, documentId) {
      try {
        return await withActor(token, async (tx): Promise<TeacherWorkOutcome> => {
          const rows = (await tx.query<Record<string, unknown>>(SQL, [documentId])).rows;
          if (rows.length === 0) return { status: "not_found" };
          if (rows.length !== 1) throw new Malformed();
          const work = toWork(rows[0]!);
          if (work.documentId !== documentId) throw new Malformed();
          return { status: "ok", work };
        });
      } catch (thrown) {
        if (thrown instanceof Malformed) return { status: "unavailable" };
        return codeOf(thrown) === "ZD401"
          ? { status: "unauthenticated" }
          : { status: "unavailable" };
      }
    },
  };
}
