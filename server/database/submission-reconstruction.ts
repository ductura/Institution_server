// The student's read of the verdict the worker keeps for a recorded submission
// (F4-PM2-R01, 20261220460000): app.my_submission_reconstruction. Who asks comes
// only from the session token; another person's submission, an unknown
// assignment and one without a submission are all not_found, and an id that is
// not a lowercase uuid is never sent. A row the port cannot vouch for throws, so
// the route answers 503.
import type { WithActor } from "./with-actor.ts";

export type SubmissionReconstructionState = "pending" | "verified" | "mismatch";

export type SubmissionReconstructionRead =
  | { status: "read"; state: SubmissionReconstructionState }
  | { status: "not_found" }
  | { status: "unauthorized" };

export type SubmissionReconstructionPort = {
  read(token: string, assignmentId: string): Promise<SubmissionReconstructionRead>;
};

const READ_SQL = "SELECT outcome, state FROM app.my_submission_reconstruction($1::uuid)";
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATES = new Set<unknown>(["pending", "verified", "mismatch"]);

export function createSubmissionReconstructionPort(
  withActor: WithActor,
): SubmissionReconstructionPort {
  return {
    async read(token, assignmentId) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<{ outcome?: unknown; state?: unknown }>(READ_SQL, [
            assignmentId,
          ]);
          const row = rows.length === 1 ? rows[0] : undefined;
          if (row?.outcome === "not_found" && row.state === null)
            return { status: "not_found" } as const;
          if (row?.outcome !== "found" || !STATES.has(row.state))
            throw new Error("Invalid submission reconstruction response");
          return { status: "read", state: row.state as SubmissionReconstructionState } as const;
        });
      } catch (error) {
        // ZD401: no session (a missing or ended one), told apart from a refusal.
        if ((error as { code?: unknown } | null)?.code === "ZD401")
          return { status: "unauthorized" };
        throw error;
      }
    },
  };
}
