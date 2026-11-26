// SRV-NF4-KASNA-POLJE (Ductus#2055, orchestrator decision A): migration
// 20261219160000. Whether a submission after the deadline of an assignment is
// allowed. The teacher of the assignment sets it
// (institution.set_late_submission_allowed); a student of its course reads it
// (app.my_assignment_late_submission); the teacher of the assignment reads it
// back (app.teacher_assignment_late_submission, F4-NAS-R01). Who asks comes only from the session
// token; a refusal (ZD403, not_found) is not_found, the same as for an
// assignment that does not exist, and an id that is not a lowercase uuid is
// never sent. A row the port cannot vouch for throws, so the route answers 503.

import type { WithActor } from "./with-actor.ts";

export type LateSubmissionSetting =
  | { readonly status: "read"; readonly lateSubmissionAllowed: boolean }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

export type LateSubmissionPort = {
  /** The teacher of the assignment sets it; the value in force again changes nothing. */
  set(token: string, assignmentId: string, allowed: boolean): Promise<LateSubmissionSetting>;
  /** A student of the course of the assignment reads it. */
  read(token: string, assignmentId: string): Promise<LateSubmissionSetting>;
  /** The teacher of the assignment reads it back (F4-NAS-R01). */
  readAsTeacher(token: string, assignmentId: string): Promise<LateSubmissionSetting>;
};

const SET_SQL = `SELECT late_submission_allowed AS "allowed"
  FROM institution.set_late_submission_allowed($1::uuid, $2::boolean)`;
const READ_SQL = `SELECT outcome, late_submission_allowed AS "allowed"
  FROM app.my_assignment_late_submission($1::uuid)`;
const TEACHER_READ_SQL = `SELECT outcome, late_submission_allowed AS "allowed"
  FROM app.teacher_assignment_late_submission($1::uuid)`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Row = { outcome?: unknown; allowed?: unknown };

function onlyRow(rows: readonly Row[]): Row {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) throw new Error("Invalid late submission response");
  return row;
}

function allowedOf(row: Row): boolean {
  if (typeof row.allowed !== "boolean") throw new Error("Invalid late submission response");
  return row.allowed;
}

function refusalOf(error: unknown): LateSubmissionSetting | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid_input" };
  return undefined;
}

async function refused(run: () => Promise<LateSubmissionSetting>): Promise<LateSubmissionSetting> {
  try {
    return await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) return refusal;
    throw error;
  }
}

export function createLateSubmissionPort(withActor: WithActor): LateSubmissionPort {
  /** One read of the field: found with its value, or not_found with nothing. */
  const readWith = async (
    sql: string,
    token: string,
    assignmentId: string,
  ): Promise<LateSubmissionSetting> => {
    if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
    return refused(() =>
      withActor(token, async (tx) => {
        const row = onlyRow((await tx.query<Row>(sql, [assignmentId])).rows);
        if (row.outcome === "not_found" && row.allowed === null)
          return { status: "not_found" as const };
        if (row.outcome !== "found") throw new Error("Invalid late submission response");
        return { status: "read" as const, lateSubmissionAllowed: allowedOf(row) };
      }),
    );
  };
  return {
    async set(token, assignmentId, allowed) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      if (typeof allowed !== "boolean") return { status: "invalid_input" };
      return refused(() =>
        withActor(token, async (tx) => {
          const value = allowedOf(
            onlyRow((await tx.query<Row>(SET_SQL, [assignmentId, allowed])).rows),
          );
          // Confirmed inside the transaction, so another answer rolls the write back.
          if (value !== allowed) throw new Error("Unconfirmed late submission change");
          return { status: "read" as const, lateSubmissionAllowed: value };
        }),
      );
    },
    read: (token, assignmentId) => readWith(READ_SQL, token, assignmentId),
    readAsTeacher: (token, assignmentId) => readWith(TEACHER_READ_SQL, token, assignmentId),
  };
}
