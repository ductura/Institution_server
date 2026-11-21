// The port of submission withdrawal (SRV-1903, P-D3; migration
// 20261201100100): the student withdraws a confirmed submission while the
// deadline in force lasts and binds the signature of its receipt; the student
// and a reader of the work read the history of submissions and withdrawals;
// the teacher of the assignment reads and sets the switch that allows it.
// Every write goes through an RPC, never a table, and the person and
// institution come only from the session.
//
// Refusals are outcomes, never thrown: ZD401 unauthorized, ZD403 not_found
// (one answer for every refusal, C-23), ZD422 invalid_input. Anything else,
// and any row that is not what the RPC promises, is thrown.
import type { WithActor } from "../index.ts";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/** A frozen receipt and its signature once bound (null: not bound yet). */
export type StoredWithdrawalReceipt = {
  readonly withdrawalId: string;
  readonly receiptPayload: string;
  readonly payloadDigestSha256: string;
  readonly signature: unknown;
};

export const WITHDRAW_REFUSALS = [
  "unauthorized",
  "invalid",
  "not_found",
  "none",
  "pending",
  "disabled",
  "after_deadline",
  "key_unavailable",
] as const;
export type WithdrawRefusal = (typeof WITHDRAW_REFUSALS)[number];
export type WithdrawOutcome =
  | ({ readonly status: "withdrawn" | "existing" } & StoredWithdrawalReceipt)
  | { readonly status: WithdrawRefusal };

export const ATTACH_REFUSALS = [
  "unauthorized",
  "invalid",
  "not_found",
  "digest_mismatch",
  "key_mismatch",
  "key_revoked",
  "key_not_valid",
] as const;
export type AttachRefusal = (typeof ATTACH_REFUSALS)[number];
export type AttachOutcome =
  | {
      readonly status: "attached" | "existing";
      readonly receiptPayload: string;
      readonly payloadDigestSha256: string;
      readonly signature: unknown;
    }
  | { readonly status: AttachRefusal };

/** One submission or withdrawal, oldest first; the receipt text is the database's, unparsed. */
export type SubmissionHistoryEvent = {
  readonly kind: "submission" | "withdrawal";
  readonly id: string;
  readonly attempt: number;
  readonly submissionId: string;
  readonly revision: number;
  readonly at: string;
  readonly afterDeadline: boolean | null;
  readonly receiptPayload: string | null;
  readonly payloadDigestSha256: string | null;
  readonly signature: unknown;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type StudentHistoryRead =
  | {
      readonly status: "read";
      readonly withdrawalAllowed: boolean;
      readonly dueAt: string;
      readonly events: SubmissionHistoryEvent[];
    }
  | Refusal;
export type TeacherHistoryRead =
  { readonly status: "read"; readonly events: SubmissionHistoryEvent[] } | Refusal;
export type WithdrawalSetting =
  | { readonly status: "read"; readonly allowed: boolean; readonly changedAt: string | null }
  | Refusal
  | { readonly status: "invalid_input" };

const WITHDRAW_SQL = `SELECT outcome, withdrawal_id::text AS "withdrawalId", receipt_payload AS "receiptPayload",
       payload_digest_sha256 AS "payloadDigestSha256", signature
  FROM app.withdraw_submission($1::uuid, $2, $3)`;
const ATTACH_SQL = `SELECT outcome, receipt_payload AS "receiptPayload",
       payload_digest_sha256 AS "payloadDigestSha256", signature
  FROM app.attach_withdrawal_receipt($1::uuid, $2, $3::jsonb)`;
const EVENT_FIELDS = `kind, event_id::text AS "eventId", attempt, submission_id::text AS "submissionId",
       revision::text AS revision, at, after_deadline AS "afterDeadline", receipt_payload AS "receiptPayload",
       payload_digest_sha256 AS "payloadDigestSha256", signature`;
const TERMS_SQL = `SELECT outcome, allowed, due_at AS "dueAt" FROM app.my_withdrawal_terms($1::uuid)`;
const MY_HISTORY_SQL = `SELECT ${EVENT_FIELDS} FROM app.my_submission_history($1::uuid)`;
const TEACHER_HISTORY_SQL = `SELECT ${EVENT_FIELDS} FROM app.teacher_submission_history($1::uuid, $2::uuid)`;
const SETTING_SQL = `SELECT allowed, changed_at AS "changedAt"
  FROM institution.submission_withdrawal_setting($1::uuid)`;
const SET_SQL = `SELECT allowed, changed_at AS "changedAt"
  FROM institution.set_submission_withdrawal($1::uuid, $2::boolean)`;

type Row = Record<string, unknown>;

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);
const isKeyPart = (value: string) => value.length >= 1 && value.length <= 256;

function instantOf(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid withdrawal timestamp");
  }
  return value.toISOString();
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

function single(rows: Row[]): Row {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new Error("unexpected withdrawal answer");
  return row;
}

function storedReceipt(row: Row, withdrawalId: unknown): StoredWithdrawalReceipt {
  if (
    !isId(withdrawalId) ||
    typeof row.receiptPayload !== "string" ||
    typeof row.payloadDigestSha256 !== "string" ||
    !SHA256.test(row.payloadDigestSha256) ||
    (row.signature !== null && (typeof row.signature !== "object" || Array.isArray(row.signature)))
  ) {
    throw new Error("invalid withdrawal receipt row");
  }
  return {
    withdrawalId,
    receiptPayload: row.receiptPayload,
    payloadDigestSha256: row.payloadDigestSha256,
    signature: row.signature,
  };
}

function eventOf(row: Row): SubmissionHistoryEvent {
  const revision = Number(row.revision);
  if (
    (row.kind !== "submission" && row.kind !== "withdrawal") ||
    !isId(row.eventId) ||
    !isId(row.submissionId) ||
    typeof row.attempt !== "number" ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    typeof row.revision !== "string" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (row.afterDeadline !== null && typeof row.afterDeadline !== "boolean") ||
    (row.kind === "submission") !== (row.afterDeadline !== null) ||
    (row.receiptPayload !== null && typeof row.receiptPayload !== "string") ||
    (row.payloadDigestSha256 !== null &&
      (typeof row.payloadDigestSha256 !== "string" || !SHA256.test(row.payloadDigestSha256))) ||
    (row.signature !== null && row.receiptPayload === null)
  ) {
    throw new Error("invalid submission history row");
  }
  return {
    kind: row.kind,
    id: row.eventId,
    attempt: row.attempt,
    submissionId: row.submissionId,
    revision,
    at: instantOf(row.at),
    afterDeadline: row.afterDeadline,
    receiptPayload: row.receiptPayload,
    payloadDigestSha256: row.payloadDigestSha256 as string | null,
    signature: row.signature,
  };
}

function settingOf(row: Row): { allowed: boolean; changedAt: string | null } {
  if (typeof row.allowed !== "boolean") throw new Error("invalid withdrawal setting row");
  return {
    allowed: row.allowed,
    changedAt: row.changedAt === null ? null : instantOf(row.changedAt),
  };
}

export function createSubmissionWithdrawals(withActor: WithActor) {
  return {
    /** The student withdraws the confirmed submission of the latest attempt, frozen with this key. */
    async withdraw(
      token: string,
      assignmentId: string,
      key: { readonly keyId: string; readonly keyVersion: string },
    ): Promise<WithdrawOutcome> {
      if (!isId(assignmentId)) return { status: "not_found" };
      if (!isKeyPart(key.keyId) || !isKeyPart(key.keyVersion)) return { status: "invalid" };
      return withActor(token, async (tx) => {
        const row = single(
          (await tx.query<Row>(WITHDRAW_SQL, [assignmentId, key.keyId, key.keyVersion])).rows,
        );
        if (row.outcome === "withdrawn" || row.outcome === "existing") {
          if (row.outcome === "withdrawn" && row.signature !== null)
            throw new Error("a new withdrawal carries no signature");
          return { status: row.outcome, ...storedReceipt(row, row.withdrawalId) };
        }
        if ((WITHDRAW_REFUSALS as readonly unknown[]).includes(row.outcome))
          return { status: row.outcome as WithdrawRefusal };
        throw new Error("unknown withdrawal outcome");
      });
    },
    /** Binds the signature of a frozen withdrawal receipt once; a later bind returns the first. */
    async attach(
      token: string,
      withdrawalId: string,
      digest: string,
      signature: unknown,
    ): Promise<AttachOutcome> {
      if (!isId(withdrawalId) || !SHA256.test(digest)) return { status: "invalid" };
      return withActor(token, async (tx) => {
        const row = single(
          (await tx.query<Row>(ATTACH_SQL, [withdrawalId, digest, JSON.stringify(signature)])).rows,
        );
        if (row.outcome === "attached" || row.outcome === "existing") {
          const stored = storedReceipt(row, withdrawalId);
          if (stored.signature === null)
            throw new Error("a bound withdrawal receipt has a signature");
          return {
            status: row.outcome,
            receiptPayload: stored.receiptPayload,
            payloadDigestSha256: stored.payloadDigestSha256,
            signature: stored.signature,
          };
        }
        if ((ATTACH_REFUSALS as readonly unknown[]).includes(row.outcome))
          return { status: row.outcome as AttachRefusal };
        throw new Error("unknown withdrawal attach outcome");
      });
    },
    /** The caller's own history on the assignment, with the switch and the deadline in force. */
    async studentHistory(token: string, assignmentId: string): Promise<StudentHistoryRead> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx): Promise<StudentHistoryRead> => {
          const terms = single((await tx.query<Row>(TERMS_SQL, [assignmentId])).rows);
          if (terms.outcome === "not_found") return { status: "not_found" };
          if (terms.outcome !== "found" || typeof terms.allowed !== "boolean")
            throw new Error("invalid withdrawal terms row");
          const { rows } = await tx.query<Row>(MY_HISTORY_SQL, [assignmentId]);
          return {
            status: "read",
            withdrawalAllowed: terms.allowed,
            dueAt: instantOf(terms.dueAt),
            events: rows.map(eventOf),
          };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** One student's history for a reader of the work (teacher, mentor, committee). */
    async teacherHistory(
      token: string,
      assignmentId: string,
      studentId: string,
    ): Promise<TeacherHistoryRead> {
      if (!isId(assignmentId) || !isId(studentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(TEACHER_HISTORY_SQL, [assignmentId, studentId]);
          return { status: "read", events: rows.map(eventOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The switch of the assignment, for its teacher. */
    async setting(token: string, assignmentId: string): Promise<WithdrawalSetting> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => ({
          status: "read" as const,
          ...settingOf(single((await tx.query<Row>(SETTING_SQL, [assignmentId])).rows)),
        }));
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The teacher of the assignment sets the switch; the value in force again changes nothing. */
    async setSetting(
      token: string,
      assignmentId: string,
      allowed: boolean,
    ): Promise<WithdrawalSetting> {
      if (!isId(assignmentId)) return { status: "not_found" };
      if (typeof allowed !== "boolean") return { status: "invalid_input" };
      try {
        return await withActor(token, async (tx) => {
          const setting = settingOf(
            single((await tx.query<Row>(SET_SQL, [assignmentId, allowed])).rows),
          );
          // Confirmed inside the transaction, so another answer rolls the write back.
          if (setting.allowed !== allowed) throw new Error("unconfirmed withdrawal setting");
          return { status: "read" as const, ...setting };
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = refusalOf(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type SubmissionWithdrawals = ReturnType<typeof createSubmissionWithdrawals>;
