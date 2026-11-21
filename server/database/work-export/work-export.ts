// The source of the DOCX export of one work, for its owner and the teacher of
// its assignment (SRV-1310, plan M8.4): one saved version with the exact bytes
// of its text. Who asks comes only from the session token bound into
// withActor; app.read_work_export decides access with the replay's relation
// (collaboration.document_scope and actor_role), answers one not_found row for
// every refusal, a missing work and a missing version alike (C-23), cuts the
// versions at the submitted revision as app.read_work_versions does and writes
// the teacher's row of the access log in the same transaction. Nothing here
// writes. The row is checked before it leaves this folder.
import type { WithActor } from "../index.ts";

export type WorkExportSource =
  | {
      readonly status: "found";
      readonly revision: number;
      /** `submitted` for the revision the student submitted, `saved` otherwise. */
      readonly kind: "saved" | "submitted";
      /** The exact bytes of the stored text of the revision. */
      readonly body: string;
      /** When the version was stored; the database's clock, never the client's. */
      readonly savedAt: string;
    }
  | { readonly status: "not_found" }
  | { readonly status: "unauthenticated" }
  | { readonly status: "invalid_input" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { readonly status: "unavailable"; readonly reason: "rows_malformed" };

/** The source of `documentId` for the session `token`; a null revision asks for the newest. */
export type WorkExportReader = (
  token: string,
  documentId: string,
  revision: number | null,
) => Promise<WorkExportSource>;

type Row = Record<string, unknown>;

const SQL = `SELECT outcome, revision::text AS revision, kind, body, saved_at AS "savedAt"
  FROM app.read_work_export($1, $2::bigint)`;
// int8 travels as text; revision 0 is the empty document and never a version.
const REVISION = /^[1-9][0-9]{0,15}$/;
const MALFORMED = { status: "unavailable", reason: "rows_malformed" } as const;

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** The rows of one call as a source: one `not_found` row, or one well formed `found` row. */
export function sourceOf(rows: readonly Row[], asked: number | null): WorkExportSource {
  if (rows.length !== 1) return MALFORMED;
  const row = rows[0] as Row;
  if (row.outcome === "not_found") return { status: "not_found" };
  const { kind, body, savedAt } = row;
  if (
    row.outcome !== "found" ||
    typeof row.revision !== "string" ||
    !REVISION.test(row.revision) ||
    (kind !== "saved" && kind !== "submitted") ||
    typeof body !== "string" ||
    body === "" ||
    !(savedAt instanceof Date) ||
    !Number.isFinite(savedAt.getTime())
  ) {
    return MALFORMED;
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || (asked !== null && revision !== asked)) return MALFORMED;
  return { status: "found", revision, kind, body, savedAt: savedAt.toISOString() };
}

/** The reader over main's application withActor; the token is only presented, never a parameter. */
export function createWorkExportReader(withActor: WithActor): WorkExportReader {
  return async (token, documentId, revision) => {
    if (revision !== null && !(Number.isSafeInteger(revision) && revision >= 1)) {
      return { status: "invalid_input" };
    }
    let rows: Row[];
    try {
      rows = (await withActor(token, (tx) => tx.query<Row>(SQL, [documentId, revision]))).rows;
    } catch (error) {
      // ZD401: no open session (DAN-85). Anything else is the route's 503.
      if (codeOf(error) === "ZD401") return { status: "unauthenticated" };
      throw error;
    }
    return sourceOf(rows, revision);
  };
}
