// The port of late-submission exceptions (SRV-NF4-IZNIMKA-ZAPIS; migration
// 20261219290000): the teacher of an assignment records that one student may
// still submit until a time, with a reason from the closed list of N-13, and
// lists the records; the student reads the own. Every write goes through an
// RPC, never the table, and the author, the student of a read and the
// institution come only from the session. A record is append-only and its audit
// row is written by the same RPC; the reason is null on a record another
// teacher wrote.
//
// The input is checked here before the database checks it again. Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD422 invalid_input (also a time that is not later than
// now, than the deadline in force or than the student's earlier exception).
// Anything else is thrown.
import type { WithActor } from "../index.ts";

const REASONS = ["justified", "technical", "agreement"] as const;
type Reason = (typeof REASONS)[number];

export type LateException = {
  readonly id: string;
  readonly studentId: string;
  readonly untilAt: string;
  /** Null on a record another teacher wrote. */
  readonly reasonId: Reason | null;
  readonly createdBy: string;
  readonly createdAt: string;
};

/** What the student sees of the own exception; kind is the mark "iznimka". */
export type OwnLateException = {
  readonly id: string;
  readonly kind: "exception";
  readonly untilAt: string;
  readonly reasonId: Reason;
  readonly createdAt: string;
};

export type LateExceptionInput = {
  readonly assignmentId: string;
  readonly studentId: string;
  /** An instant as Date.toISOString writes it. */
  readonly untilAt: string;
  readonly reasonId: string;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type LateExceptionGrant =
  | { readonly status: "granted"; readonly exception: LateException }
  | Refusal
  | { readonly status: "invalid_input" };
export type LateExceptionList =
  { readonly status: "read"; readonly exceptions: LateException[] } | Refusal;
export type OwnLateExceptionList =
  { readonly status: "read"; readonly exceptions: OwnLateException[] } | Refusal;

const FIELDS =
  'id, student_id AS "studentId", until_at AS "untilAt", reason_id AS "reasonId", ' +
  'created_by AS "createdBy", created_at AS "createdAt"';
const GRANT_SQL = `SELECT ${FIELDS}
  FROM institution.grant_late_submission_exception($1::uuid, $2::uuid, $3::timestamptz, $4::text)`;
const LIST_SQL = `SELECT ${FIELDS} FROM institution.late_submission_exceptions($1::uuid)`;
const OWN_SQL = `SELECT id, until_at AS "untilAt", reason_id AS "reasonId", created_at AS "createdAt"
  FROM institution.student_late_submission_exceptions($1::uuid)`;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type Row = {
  id: unknown;
  studentId?: unknown;
  untilAt: unknown;
  reasonId: unknown;
  createdBy?: unknown;
  createdAt: unknown;
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
    throw new Error("invalid late exception timestamp");
  }
  return value.toISOString();
}

function exceptionOf(row: Row): LateException {
  if (
    !isId(row.id) ||
    !isId(row.studentId) ||
    (row.reasonId !== null && !isReason(row.reasonId)) ||
    !isId(row.createdBy)
  ) {
    throw new Error("invalid late exception row");
  }
  return {
    id: row.id,
    studentId: row.studentId,
    untilAt: instantOf(row.untilAt),
    reasonId: row.reasonId,
    createdBy: row.createdBy,
    createdAt: instantOf(row.createdAt),
  };
}

function ownOf(row: Row): OwnLateException {
  if (!isId(row.id) || !isReason(row.reasonId)) throw new Error("invalid late exception row");
  return {
    id: row.id,
    kind: "exception",
    untilAt: instantOf(row.untilAt),
    reasonId: row.reasonId,
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

export function createLateExceptions(withActor: WithActor) {
  return {
    /** The teacher of the assignment records an exception for one student. */
    async grantLateException(
      token: string,
      input: LateExceptionInput,
    ): Promise<LateExceptionGrant> {
      const untilAt = instantInput(input.untilAt);
      if (
        !isId(input.assignmentId) ||
        !isId(input.studentId) ||
        untilAt === undefined ||
        !isReason(input.reasonId)
      ) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(GRANT_SQL, [
            input.assignmentId,
            input.studentId,
            untilAt,
            input.reasonId,
          ]);
          const row = rows[0];
          // Confirmed inside the transaction, so an answer that is not this
          // exception rolls the write and its audit row back.
          if (
            rows.length !== 1 ||
            row === undefined ||
            row.studentId !== input.studentId ||
            row.reasonId !== input.reasonId
          ) {
            throw new Error("unconfirmed late exception");
          }
          const exception = exceptionOf(row);
          if (exception.untilAt !== untilAt) throw new Error("unconfirmed late exception");
          return { status: "granted", exception };
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = refusalOf(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The exceptions of an assignment, oldest first, for its teacher. */
    async listLateExceptions(token: string, assignmentId: string): Promise<LateExceptionList> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(LIST_SQL, [assignmentId]);
          return { status: "read", exceptions: rows.map(exceptionOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The caller's own exceptions on an assignment, oldest first, for the student. */
    async listOwnLateExceptions(
      token: string,
      assignmentId: string,
    ): Promise<OwnLateExceptionList> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(OWN_SQL, [assignmentId]);
          return { status: "read", exceptions: rows.map(ownOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}
