// The port of copying an assignment (SRV-1904, P-D4; migration
// 20261201190400): the teacher of an assignment copies it into a course they
// teach. The copy is a new assignment at version 1 with the content of the
// source's current version; the write goes through the RPC only, and the
// author and institution come only from the session.
//
// The input is checked here before the database checks it again. Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD409 conflict (the key was used for another copy),
// ZD422 invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

export type AssignmentCopyInput = {
  readonly assignmentId: string;
  readonly courseId: string;
  readonly requestKey: string;
  /** An instant as Date.toISOString writes it; null keeps the source's. */
  readonly opensAt: string | null;
  /** An instant as Date.toISOString writes it; null keeps the source's. */
  readonly dueAt: string | null;
};

export type AssignmentCopyResult =
  | { readonly status: "copied"; readonly id: string }
  | { readonly status: "unauthorized" | "not_found" | "conflict" | "invalid_input" };

const COPY_SQL = `SELECT institution.copy_assignment(
  $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz) AS id`;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);

/** Null, or a finite instant written by Date.toISOString; undefined otherwise. */
function instantInput(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (!INSTANT.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : undefined;
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

/** The refusals of the RPC, by SQLSTATE. */
const REFUSALS = new Map<unknown, AssignmentCopyResult>([
  ["ZD401", { status: "unauthorized" }],
  ["ZD403", { status: "not_found" }],
  ["ZD409", { status: "conflict" }],
  ["ZD422", { status: "invalid_input" }],
]);

export function createAssignmentCopy(withActor: WithActor) {
  return {
    /** The teacher copies the assignment into the course; the new id. */
    async copy(token: string, input: AssignmentCopyInput): Promise<AssignmentCopyResult> {
      const opensAt = instantInput(input.opensAt);
      const dueAt = instantInput(input.dueAt);
      if (!isId(input.assignmentId) || !isId(input.courseId)) return { status: "not_found" };
      if (!isId(input.requestKey) || opensAt === undefined || dueAt === undefined) {
        return { status: "invalid_input" };
      }
      if (opensAt !== null && dueAt !== null && opensAt >= dueAt) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<{ id: unknown }>(COPY_SQL, [
            input.assignmentId,
            input.courseId,
            input.requestKey,
            opensAt,
            dueAt,
          ]);
          const id = rows[0]?.id;
          // Confirmed inside the transaction, so an answer that is not one id
          // rolls the write back.
          if (rows.length !== 1 || !isId(id)) throw new Error("unconfirmed assignment copy");
          return { status: "copied", id };
        });
      } catch (error) {
        const refusal = REFUSALS.get(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type AssignmentCopy = ReturnType<typeof createAssignmentCopy>;
