// The port of deadline extensions (SRV-1108; migration 20261121106000): the
// teacher of an assignment extends its deadline for one student or for all of
// them, with a reason from the closed list of N-13, and lists the extensions.
// Every write goes through an RPC, never the table, and the author and
// institution come only from the session. A record is append-only; the
// reason is null on a record another teacher wrote.
//
// The input is checked here before the database checks it again. Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD422 invalid_input (also a deadline that is not later
// than the one in force). Anything else is thrown.
import type { WithActor } from "../index.ts";

const REASONS = ["justified", "technical", "agreement", "all"] as const;
type Reason = (typeof REASONS)[number];

export type DeadlineExtension = {
  readonly id: string;
  readonly scope: "one" | "all";
  readonly studentId: string | null;
  readonly previousDueAt: string;
  readonly dueAt: string;
  readonly reasonId: Reason | null;
  readonly createdBy: string;
  readonly createdAt: string;
};

export type DeadlineExtensionInput = {
  readonly assignmentId: string;
  /** Null: every student of the assignment. */
  readonly studentId: string | null;
  /** An instant as Date.toISOString writes it. */
  readonly dueAt: string;
  readonly reasonId: string;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type DeadlineExtensionAdd =
  | {
      readonly status: "added";
      readonly extension: DeadlineExtension;
      readonly existingSubmissionsUnchanged: boolean;
    }
  | Refusal
  | { readonly status: "invalid_input" };
export type DeadlineExtensionList =
  { readonly status: "read"; readonly extensions: DeadlineExtension[] } | Refusal;

const FIELDS =
  'id, student_id AS "studentId", previous_due_at AS "previousDueAt", due_at AS "dueAt", ' +
  'reason_id AS "reasonId", created_by AS "createdBy", created_at AS "createdAt"';
const ADD_SQL = `SELECT ${FIELDS}, earlier_submissions AS "earlierSubmissions"
  FROM institution.extend_assignment_deadline($1::uuid, $2::uuid, $3::timestamptz, $4::text)`;
const LIST_SQL = `SELECT ${FIELDS} FROM institution.deadline_extensions($1::uuid)`;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type Row = {
  id: unknown;
  studentId: unknown;
  previousDueAt: unknown;
  dueAt: unknown;
  reasonId: unknown;
  createdBy: unknown;
  createdAt: unknown;
  earlierSubmissions?: unknown;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);
const isReason = (value: unknown): value is Reason =>
  (REASONS as readonly unknown[]).includes(value);

/** A finite instant written by Date.toISOString, or undefined. */
function instantInput(value: unknown): string | undefined {
  if (typeof value !== "string" || !INSTANT.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : undefined;
}

function instantOf(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid deadline extension timestamp");
  }
  return value.toISOString();
}

function extensionOf(row: Row): DeadlineExtension {
  if (
    !isId(row.id) ||
    (row.studentId !== null && !isId(row.studentId)) ||
    (row.reasonId !== null && !isReason(row.reasonId)) ||
    !isId(row.createdBy)
  ) {
    throw new Error("invalid deadline extension row");
  }
  const previousDueAt = instantOf(row.previousDueAt);
  const dueAt = instantOf(row.dueAt);
  if (dueAt <= previousDueAt) throw new Error("invalid deadline extension row");
  return {
    id: row.id,
    scope: row.studentId === null ? "all" : "one",
    studentId: row.studentId as string | null,
    previousDueAt,
    dueAt,
    reasonId: row.reasonId as Reason | null,
    createdBy: row.createdBy,
    createdAt: instantOf(row.createdAt),
  };
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(code: unknown): Refusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

export function createDeadlineExtensions(withActor: WithActor) {
  return {
    /** The teacher of the assignment records an extension for one student or for all. */
    async add(token: string, input: DeadlineExtensionInput): Promise<DeadlineExtensionAdd> {
      const dueAt = instantInput(input.dueAt);
      if (
        !isId(input.assignmentId) ||
        (input.studentId !== null && !isId(input.studentId)) ||
        dueAt === undefined ||
        !isReason(input.reasonId) ||
        (input.reasonId === "all" && input.studentId !== null)
      ) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(ADD_SQL, [
            input.assignmentId,
            input.studentId,
            dueAt,
            input.reasonId,
          ]);
          const row = rows[0];
          // Confirmed inside the transaction, so an answer that is not this
          // extension rolls the write back.
          if (
            rows.length !== 1 ||
            row === undefined ||
            row.studentId !== input.studentId ||
            row.reasonId !== input.reasonId ||
            typeof row.earlierSubmissions !== "boolean"
          ) {
            throw new Error("unconfirmed deadline extension");
          }
          const extension = extensionOf(row);
          if (extension.dueAt !== dueAt) throw new Error("unconfirmed deadline extension");
          return {
            status: "added",
            extension,
            existingSubmissionsUnchanged: row.earlierSubmissions,
          };
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = refusalOf(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The extensions of an assignment, oldest first, for its teacher. */
    async list(token: string, assignmentId: string): Promise<DeadlineExtensionList> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(LIST_SQL, [assignmentId]);
          return { status: "read", extensions: rows.map(extensionOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type DeadlineExtensions = ReturnType<typeof createDeadlineExtensions>;
