// SRV-1303 (M10.0-S2): the retention role's call of app.purge_ended_sessions
// (migration 20261207100000), the port of the scheduled job in
// server/session/purge-ended. The client is one connection of a login that is
// a member of ductus_retention, opened by the worker's composition root; the
// web role has no EXECUTE on the function.
//
// `purge` deletes the sessions that ended before the cut and returns their
// number. `count` runs the same function inside a transaction it always rolls
// back, so the dry run counts exactly what the purge would delete and keeps
// every row. Errors are closed codes (ScheduledJobError), never database text:
// ZD422 (a cut inside the 30 days of D-200 P2, or none) `invalid_cut`, a row
// of another shape `invalid_count`, anything else `purge_unavailable`.
import { ScheduledJobError } from "./schedule.ts";

/** One connection: the statements of one call run on it in order. */
export type RetentionClient = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export type EndedSessionsPurge = {
  /** Deletes the sessions that ended before `before` and returns how many. */
  purge(before: Date): Promise<number>;
  /** How many sessions `purge(before)` would delete now. Deletes nothing. */
  count(before: Date): Promise<number>;
};

const PURGE_SQL = "SELECT app.purge_ended_sessions($1::timestamptz) AS deleted";

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): ScheduledJobError {
  if (thrown instanceof ScheduledJobError) return thrown;
  return new ScheduledJobError(codeOf(thrown) === "ZD422" ? "invalid_cut" : "purge_unavailable");
}

export function createEndedSessionsPurge(client: RetentionClient): EndedSessionsPurge {
  async function call(before: Date): Promise<number> {
    const time = before.getTime();
    if (!Number.isFinite(time)) throw new ScheduledJobError("invalid_cut");
    const { rows } = await client.query(PURGE_SQL, [before.toISOString()]);
    const deleted: unknown = rows.length === 1 ? rows[0]?.["deleted"] : undefined;
    if (typeof deleted !== "number" || !Number.isSafeInteger(deleted) || deleted < 0)
      throw new ScheduledJobError("invalid_count");
    return deleted;
  }

  return {
    async purge(before) {
      try {
        return await call(before);
      } catch (thrown) {
        throw refusal(thrown);
      }
    },
    async count(before) {
      try {
        await client.query("BEGIN");
      } catch (thrown) {
        throw refusal(thrown);
      }
      let result: number | ScheduledJobError;
      try {
        result = await call(before);
      } catch (thrown) {
        result = refusal(thrown);
      }
      // Always rolled back: a dry run keeps every row, whatever the call returned.
      // A connection that cannot roll back gives no count; the caller drops it.
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
