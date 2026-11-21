// SRV-1702 (M6.4, DAN-420; D-21, D-34, D-244): the database port of direct
// edits of a teacher (20261129100100). Each call is one withActor transaction
// over the RPCs of schema collaboration; the RPCs decide who may: the student
// owner alone sets the mode, the student and every teacher of the work read
// the same setting and record, and a teacher of the work publishes an edit of
// the live state only while the mode is direct, read under the lock of the
// setting. The answer is a closed status, never a database message or
// SQLSTATE: ZD401 is unauthenticated, ZD403 not_found (one answer for "not
// yours", "not there", "not on", "submitted" and "no relation", C-23), ZD422
// invalid, anything else unavailable. A row of an unexpected shape is
// unavailable too. The text of the work never reaches a log or an error.
import type { ActorTransaction, WithActor } from "../index.ts";

export type DirectEditMode = "suggestions" | "direct";

export type DirectEditEntry =
  | {
      readonly kind: "mode";
      readonly source: "student";
      readonly mode: DirectEditMode;
      readonly at: string;
    }
  | {
      readonly kind: "teacher_edit";
      readonly source: "teacher";
      readonly bytes: number;
      readonly at: string;
    };

export type DirectEditRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type DirectEditState = {
  readonly status: "ok";
  readonly mode: DirectEditMode;
  readonly changedAt: string | null;
  readonly record: readonly DirectEditEntry[];
};
export type DirectEditSet = {
  readonly status: "ok";
  readonly outcome: "applied" | "unchanged";
  readonly mode: DirectEditMode;
  readonly changedAt: string | null;
};
export type TeacherEditOutcome =
  | { readonly status: "accepted" | "unchanged"; readonly token: string }
  /** The state read is no longer the live one; the teacher never gets a token. */
  | { readonly status: "conflict"; readonly token: null }
  | DirectEditRefusal;

export type DirectEdits = {
  read(token: string, documentId: string): Promise<DirectEditState | DirectEditRefusal>;
  set(
    token: string,
    documentId: string,
    mode: DirectEditMode,
  ): Promise<DirectEditSet | DirectEditRefusal>;
  /** `expectedHash` is the content hash of the ETag the teacher read. */
  publishTeacherEdit(
    token: string,
    documentId: string,
    expectedHash: string,
    text: string,
  ): Promise<TeacherEditOutcome>;
};

const SQL = {
  setting: 'SELECT mode, changed_at AS "changedAt" FROM collaboration.read_direct_edit($1)',
  record:
    "SELECT kind, source, mode, body_bytes AS bytes, at FROM collaboration.list_direct_edit_record($1)",
  set: 'SELECT outcome, mode, changed_at AS "changedAt" FROM collaboration.set_direct_edit($1, $2)',
  publish:
    "SELECT outcome, write_token AS token FROM collaboration.publish_teacher_direct_edit($1, $2, $3)",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function refusal(thrown: unknown): DirectEditRefusal {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

const isMode = (value: unknown): value is DirectEditMode =>
  value === "suggestions" || value === "direct";
const instant = (value: unknown): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
};
const instantOrNull = (value: unknown): string | null => (value === null ? null : instant(value));

function toEntry(row: Record<string, unknown>): DirectEditEntry {
  if (row.kind === "mode" && row.source === "student" && isMode(row.mode) && row.bytes === null) {
    return { kind: "mode", source: "student", mode: row.mode, at: instant(row.at) };
  }
  if (
    row.kind === "teacher_edit" &&
    row.source === "teacher" &&
    row.mode === null &&
    Number.isInteger(row.bytes) &&
    (row.bytes as number) >= 1
  ) {
    return {
      kind: "teacher_edit",
      source: "teacher",
      bytes: row.bytes as number,
      at: instant(row.at),
    };
  }
  throw new Malformed();
}

export function createDirectEdits(withActor: WithActor): DirectEdits {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | DirectEditRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;

  return {
    read: (token, documentId) =>
      run(token, async (tx) => {
        const setting = await rowsOf(tx, SQL.setting, [documentId]);
        const row = setting.length === 1 ? setting[0]! : undefined;
        if (row === undefined || !isMode(row.mode)) throw new Malformed();
        const record = (await rowsOf(tx, SQL.record, [documentId])).map(toEntry);
        return {
          status: "ok" as const,
          mode: row.mode,
          changedAt: instantOrNull(row.changedAt),
          record,
        };
      }),

    set: (token, documentId, mode) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.set, [documentId, mode]);
        const row = rows.length === 1 ? rows[0]! : undefined;
        if (
          row === undefined ||
          (row.outcome !== "applied" && row.outcome !== "unchanged") ||
          row.mode !== mode
        ) {
          throw new Malformed();
        }
        return {
          status: "ok" as const,
          outcome: row.outcome,
          mode,
          changedAt: instantOrNull(row.changedAt),
        };
      }),

    async publishTeacherEdit(token, documentId, expectedHash, text) {
      return run(token, async (tx): Promise<TeacherEditOutcome> => {
        const rows = await rowsOf(tx, SQL.publish, [documentId, expectedHash, text]);
        const row = rows.length === 1 ? rows[0]! : undefined;
        if (row?.outcome === "conflict" && row.token === null) {
          return { status: "conflict", token: null };
        }
        if (
          (row?.outcome === "accepted" || row?.outcome === "unchanged") &&
          typeof row.token === "string" &&
          UUID.test(row.token)
        ) {
          return { status: row.outcome, token: row.token };
        }
        throw new Malformed();
      });
    },
  };
}
