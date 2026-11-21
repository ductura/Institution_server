import type { WithActor } from "../index.ts";

// SRV-1407: the moves of one mentorship request, each one RPC of the main
// database. The actor comes from the session bound to the transaction; the
// functions decide who may, and refuse with ZD401, ZD403, ZD409, ZD422 or
// ZD503, which the HTTP adapter maps.
const REQUEST_SQL = "SELECT institution.request_mentorship($1::uuid, $2::text) AS id";
const APPROVE_SQL = "SELECT app.approve_mentorship_request_once($1::uuid) AS id";
const DECLINE_SQL = "SELECT institution.decline_mentorship_request($1::uuid, $2::text) AS done";
const WITHDRAW_SQL = "SELECT institution.withdraw_mentorship_request($1::uuid) AS done";

export type MentorshipRequestStore = ReturnType<typeof createMentorshipRequestStore>;

export function createMentorshipRequestStore(withActor: WithActor) {
  async function one<T>(token: string, sql: string, values: readonly unknown[], column: string) {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(sql, values);
      if (rows.length !== 1) throw new Error("expected one row");
      return rows[0]![column] as T;
    });
  }

  return {
    /** The id of the new open request. */
    request: (token: string, teacherId: string, workType: string) =>
      one<string>(token, REQUEST_SQL, [teacherId, workType], "id"),
    /** The mentorship of the approved request, the same on every approval. */
    approve: (token: string, requestId: string) =>
      one<string>(token, APPROVE_SQL, [requestId], "id"),
    /** True when declined now, false when it already was. */
    decline: (token: string, requestId: string, reason: string | null) =>
      one<boolean>(token, DECLINE_SQL, [requestId, reason], "done"),
    /** True when withdrawn now, false when it already was. */
    withdraw: (token: string, requestId: string) =>
      one<boolean>(token, WITHDRAW_SQL, [requestId], "done"),
  };
}
