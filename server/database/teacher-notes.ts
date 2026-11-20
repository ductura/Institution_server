// SRV-8B (Ductus#2051, D-130): the database port of the mentor's working
// records, private notes on a student's work and saved comment templates
// (20261121001000). Each call is one withActor transaction over one RPC of
// schema collaboration; the RPCs decide who may (the teacher of the work for
// notes, a confirmed teacher for a new template) and only ever return the
// caller's own rows. A note is never part of a view of the work: nothing here
// reads or writes the document, and the student has no call that reaches a
// note. The answer is a closed status, never a database message or SQLSTATE:
// ZD401 is unauthenticated, ZD403 not_found (one answer for "not yours",
// "not there" and "no relation", C-23), ZD422 invalid, anything else
// unavailable. A row of an unexpected shape is unavailable too.
import type { ActorTransaction, WithActor } from "./with-actor.ts";

export const TEMPLATE_KINDS = ["must", "sugg", "q", "praise"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export type TeacherNote = {
  readonly noteId: string;
  readonly body: string;
  /** The text anchor as stored; null for a note on the work as a whole. */
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
};
export type CommentTemplate = {
  readonly templateId: string;
  readonly kind: TemplateKind;
  readonly body: string;
  readonly createdAt: string;
};

export type Refusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type Created = {
  readonly status: "created";
  readonly id: string;
  readonly createdAt: string;
};
export type Listed<T> = { readonly status: "ok"; readonly items: readonly T[] };
export type Deleted = { readonly status: "deleted" };

export type TeacherNotes = {
  createNote(
    token: string,
    documentId: string,
    body: string,
    anchor: Readonly<Record<string, unknown>> | null,
  ): Promise<Created | Refusal>;
  listNotes(token: string, documentId: string): Promise<Listed<TeacherNote> | Refusal>;
  deleteNote(token: string, noteId: string): Promise<Deleted | Refusal>;
  createTemplate(token: string, body: string, kind: TemplateKind): Promise<Created | Refusal>;
  listTemplates(token: string): Promise<Listed<CommentTemplate> | Refusal>;
  deleteTemplate(token: string, templateId: string): Promise<Deleted | Refusal>;
};

const SQL = {
  createNote:
    'SELECT note_id AS id, created_at AS "createdAt" FROM collaboration.create_teacher_note($1, $2, $3::jsonb)',
  listNotes:
    'SELECT note_id AS "noteId", body, anchor, created_at AS "createdAt" FROM collaboration.list_teacher_notes($1)',
  deleteNote: "SELECT collaboration.delete_teacher_note($1::uuid)",
  createTemplate:
    'SELECT template_id AS id, created_at AS "createdAt" FROM collaboration.create_comment_template($1, $2)',
  listTemplates:
    'SELECT template_id AS "templateId", kind, body, created_at AS "createdAt" FROM collaboration.list_comment_templates()',
  deleteTemplate: "SELECT collaboration.delete_comment_template($1::uuid)",
} as const;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): Refusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function iso(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Malformed();
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isKind(value: unknown): value is TemplateKind {
  return (TEMPLATE_KINDS as readonly unknown[]).includes(value);
}

function created(rows: readonly Record<string, unknown>[]): Created {
  if (rows.length !== 1) throw new Malformed();
  return { status: "created", id: text(rows[0]!.id), createdAt: iso(rows[0]!.createdAt) };
}
function toNote(row: Record<string, unknown>): TeacherNote {
  if (row.anchor !== null && !isObject(row.anchor)) throw new Malformed();
  return {
    noteId: text(row.noteId),
    body: text(row.body),
    anchor: row.anchor,
    createdAt: iso(row.createdAt),
  };
}
function toTemplate(row: Record<string, unknown>): CommentTemplate {
  if (!isKind(row.kind)) throw new Malformed();
  return {
    templateId: text(row.templateId),
    kind: row.kind,
    body: text(row.body),
    createdAt: iso(row.createdAt),
  };
}

export function createTeacherNotes(withActor: WithActor): TeacherNotes {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | Refusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;

  return {
    createNote: (token, documentId, body, anchor) =>
      run(token, async (tx) =>
        created(
          await rowsOf(tx, SQL.createNote, [
            documentId,
            body,
            anchor === null ? null : JSON.stringify(anchor),
          ]),
        ),
      ),
    listNotes: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        items: (await rowsOf(tx, SQL.listNotes, [documentId])).map(toNote),
      })),
    deleteNote: (token, noteId) =>
      run(token, async (tx) => {
        await rowsOf(tx, SQL.deleteNote, [noteId]);
        return { status: "deleted" as const };
      }),
    createTemplate: (token, body, kind) =>
      run(token, async (tx) => created(await rowsOf(tx, SQL.createTemplate, [body, kind]))),
    listTemplates: (token) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        items: (await rowsOf(tx, SQL.listTemplates, [])).map(toTemplate),
      })),
    deleteTemplate: (token, templateId) =>
      run(token, async (tx) => {
        await rowsOf(tx, SQL.deleteTemplate, [templateId]);
        return { status: "deleted" as const };
      }),
  };
}
