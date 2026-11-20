// The port the documents of the Merlin package are read from (SRV-1109): one
// app.fast_path_works call under withActor (migration 20261027200000), the
// read the teacher's fast path uses. The database decides who gets rows (the
// teacher of the assignment, C-23; anyone else the same empty set), names the
// students with their name pair, gives the text checkpoint at the revision the
// teacher's window holds (for a submitted work the submitted revision) and
// writes the teacher's opening of every returned text to the access log in
// the same transaction. Nothing else is written. A row this reader cannot
// vouch for throws, so the caller answers 503 and never a partial roster.
// Rows become camelCase only here (docs/CODE_STYLE.md §9).
import type { WithActor } from "../index.ts";

export type SubmittedWorkSource = {
  readonly studentId: string;
  /** Both null when the account has no name pair, never a stand-in. */
  readonly givenName: string | null;
  readonly familyName: string | null;
  /** Null without a work or a record. */
  readonly work: {
    readonly documentId: string;
    readonly submitted: boolean;
    readonly revision: number;
    /** The JCS text of the document at that revision. */
    readonly body: string;
  } | null;
};

export type SubmittedWorksOutcome =
  | { readonly status: "read"; readonly students: readonly SubmittedWorkSource[] }
  | { readonly status: "unauthorized" };

export type SubmittedWorksReader = (
  token: string,
  assignmentId: string,
) => Promise<SubmittedWorksOutcome>;

const SQL =
  "SELECT student_id::text AS student_id, given_name, family_name, document_id, submitted, " +
  "revision::text AS revision, body FROM app.fast_path_works($1::uuid)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REVISION = /^[0-9]{1,15}$/u;
const NAME_MAX = 255;

type Row = Record<string, unknown>;

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && [...value].length <= NAME_MAX;

/** One row as a source, or throws: an answer for the whole roster. */
export function sourceOf(row: Row): SubmittedWorkSource {
  const { student_id: studentId, given_name: givenName, family_name: familyName } = row;
  if (typeof studentId !== "string" || !UUID.test(studentId)) throw new Error("invalid work row");
  const named = isName(givenName) && isName(familyName);
  if (!named && (givenName !== null || familyName !== null)) throw new Error("invalid work row");
  const names = {
    studentId,
    givenName: named ? givenName : null,
    familyName: named ? familyName : null,
  };
  if (row.document_id === null) {
    if (row.submitted !== null || row.revision !== null || row.body !== null) {
      throw new Error("invalid work row");
    }
    return { ...names, work: null };
  }
  if (
    typeof row.document_id !== "string" ||
    typeof row.submitted !== "boolean" ||
    typeof row.revision !== "string" ||
    !REVISION.test(row.revision) ||
    typeof row.body !== "string"
  ) {
    throw new Error("invalid work row");
  }
  return {
    ...names,
    work: {
      documentId: row.document_id,
      submitted: row.submitted,
      revision: Number(row.revision),
      body: row.body,
    },
  };
}

export function createSubmittedWorksReader(withActor: WithActor): SubmittedWorksReader {
  return async (token, assignmentId) => {
    try {
      const rows = await withActor(
        token,
        async (tx) => (await tx.query<Row>(SQL, [assignmentId])).rows,
      );
      const students = rows.map(sourceOf);
      if (new Set(students.map((s) => s.studentId)).size !== students.length) {
        throw new Error("duplicate work row");
      }
      return { status: "read", students };
    } catch (error) {
      if (codeOf(error) === "ZD401") return { status: "unauthorized" };
      throw error;
    }
  };
}
