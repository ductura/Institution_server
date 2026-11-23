// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
// OD-15): the declaration a submission requires, read before the request
// (20261213120000, declaration.submission_gate). While the assignment of the
// caller's document requires a declaration and none is confirmed for the
// submitted revision, the answer is declaration_required; otherwise proceed,
// also for anything app.request_submission answers itself. The trigger that
// pins the declaration to the request stays the guarantee: this read only lets
// the web process answer 409 instead of 503. Any other answer is an error, so
// a failed read never lets a submission through (PRODUCT §5 rule 11).
import type { WithActor } from "../index.ts";

export type SubmissionDeclarationGateAnswer = "proceed" | "declaration_required";

export type SubmissionDeclarationGate = (
  token: string,
  input: { readonly documentId: string; readonly revision: number },
) => Promise<SubmissionDeclarationGateAnswer>;

const SQL = "SELECT declaration.submission_gate($1, $2) AS gate";

export function createSubmissionDeclarationGate(withActor: WithActor): SubmissionDeclarationGate {
  return (token, input) =>
    withActor(token, async (tx) => {
      const { rows } = await tx.query<{ gate: unknown }>(SQL, [input.documentId, input.revision]);
      const gate = rows.length === 1 ? rows[0]?.gate : undefined;
      if (gate === "proceed" || gate === "declaration_required") return gate;
      throw new Error("Invalid submission gate response");
    });
}
