// SRV-MENTOR-3B (Ductus#2055): the retention role's call of
// collaboration.purge_orphan_work_data (migration 20261217120000), the port
// of the scheduled job purge_orphan_work_data in server/institution. The
// function removes the note to self, the seen marks, the messages and the
// teachers' notes, and since SRV-MENTOR-3C (migration 20261217170000) also
// the live state, the revision requests, the working criteria, the direct
// edits and the review marks, of works whose document no longer exists,
// through the per-work deletions of the retention role, and returns how many
// rows went. The schedule executes it (EXECUTE_ALLOWED, SRV-MENTOR-3C).
// The client is one connection of a login that is a member of
// ductus_retention, opened by the worker's composition root; the web role
// has no EXECUTE on the function.
//
// `purge` removes and returns the number. `count` runs the same function
// inside a transaction it always rolls back, so the dry run counts exactly
// what the purge would remove and keeps every row (as ended-sessions.ts).
// Errors are closed codes (ScheduledJobError), never database text: a row of
// another shape `invalid_count`, anything else `purge_unavailable`.
import type { RetentionClient } from "./ended-sessions.ts";
import { ScheduledJobError } from "./schedule.ts";

export type OrphanWorkDataPurge = {
  /** Removes the rows of works that no longer exist and returns how many. */
  purge(): Promise<number>;
  /** How many rows `purge()` would remove now. Removes nothing. */
  count(): Promise<number>;
};

const PURGE_SQL = "SELECT collaboration.purge_orphan_work_data() AS deleted";

/** A bigint arrives as a decimal string from pg; anything else is not a count. */
function countOf(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function refusal(thrown: unknown): ScheduledJobError {
  return thrown instanceof ScheduledJobError ? thrown : new ScheduledJobError("purge_unavailable");
}

export function createOrphanWorkDataPurge(client: RetentionClient): OrphanWorkDataPurge {
  async function call(): Promise<number> {
    const { rows } = await client.query(PURGE_SQL);
    const deleted = rows.length === 1 ? countOf(rows[0]?.["deleted"]) : null;
    if (deleted === null) throw new ScheduledJobError("invalid_count");
    return deleted;
  }

  return {
    async purge() {
      try {
        return await call();
      } catch (thrown) {
        throw refusal(thrown);
      }
    },
    async count() {
      try {
        await client.query("BEGIN");
      } catch (thrown) {
        throw refusal(thrown);
      }
      let result: number | ScheduledJobError;
      try {
        result = await call();
      } catch (thrown) {
        result = refusal(thrown);
      }
      // Always rolled back: a dry run keeps every row, whatever the call returned.
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new ScheduledJobError("purge_unavailable");
      }
      if (result instanceof ScheduledJobError) throw result;
      return result;
    },
  };
}
