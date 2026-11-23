// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 §6.7): the
// database port of the teacher's declaration requirement (20261214110000,
// institution.declaration_requirement and institution.set_declaration_required).
// Only the teacher of the assignment reads and sets it; every other caller and
// an unknown assignment read the same not_found (C-23). A row that is not
// exactly one boolean and a time or null is unavailable, never a guess.
import type { WithActor } from "../index.ts";

export type DeclarationRequirementState = {
  readonly required: boolean;
  /** When it was last changed, null while the default holds. */
  readonly changedAt: string | null;
};

type Failure = { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };
export type DeclarationRequirementOutcome =
  ({ readonly status: "ok" } & DeclarationRequirementState) | Failure;

export type DeclarationRequirement = {
  /** The teacher of the assignment reads the requirement. */
  read(token: string, assignmentId: string): Promise<DeclarationRequirementOutcome>;
  /** The teacher of the assignment sets it; the answer is the new state. */
  set(
    token: string,
    assignmentId: string,
    required: boolean,
  ): Promise<DeclarationRequirementOutcome>;
};

class Malformed extends Error {}

function failureOf(thrown: unknown): Failure {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  let code: unknown;
  try {
    code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    code = undefined;
  }
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function stateOf(rows: readonly Record<string, unknown>[]): DeclarationRequirementState {
  const row = rows.length === 1 ? rows[0] : undefined;
  const required = row?.required;
  const at = row?.changed_at;
  if (typeof required !== "boolean" || (at !== null && !(at instanceof Date))) {
    throw new Malformed();
  }
  return { required, changedAt: at === null ? null : at.toISOString() };
}

const READ_SQL = "SELECT required, changed_at FROM institution.declaration_requirement($1)";
const SET_SQL = "SELECT required, changed_at FROM institution.set_declaration_required($1, $2)";

export function createDeclarationRequirement(withActor: WithActor): DeclarationRequirement {
  async function one(token: string, text: string, values: unknown[]) {
    try {
      return await withActor(token, async (tx) => {
        const { rows } = await tx.query<Record<string, unknown>>(text, values);
        return { status: "ok" as const, ...stateOf(rows) };
      });
    } catch (thrown) {
      return failureOf(thrown);
    }
  }
  return {
    read: (token, assignmentId) => one(token, READ_SQL, [assignmentId]),
    set: (token, assignmentId, required) => one(token, SET_SQL, [assignmentId, required]),
  };
}
