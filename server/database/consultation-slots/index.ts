import type { WithActor } from "../index.ts";

type SlotRow = { id: string; startsAt: Date; proposedAt: Date; state: string };
type SlotAction = "accept" | "confirm" | "counter";

const COLUMNS = 'id, starts_at AS "startsAt", proposed_at AS "proposedAt", state';
const LIST_SQL = `SELECT ${COLUMNS} FROM institution.consultation_slots($1)`;
const REQUEST_SQL = `SELECT ${COLUMNS} FROM institution.request_consultation_slot($1, $2::timestamptz)`;
const TRANSITION_SQL = `SELECT ${COLUMNS} FROM institution.act_on_consultation_slot($1, $2::uuid, $3, $4::timestamptz)`;

export function createConsultationSlotStore(withActor: WithActor) {
  async function query(token: string, sql: string, values: readonly unknown[]) {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<SlotRow>(sql, values);
      return rows.map(({ id, startsAt, proposedAt, state }) => ({
        id,
        startsAt: startsAt.toISOString(),
        proposedAt: proposedAt.toISOString(),
        state,
      }));
    });
  }

  return {
    list: (token: string, documentId: string) => query(token, LIST_SQL, [documentId]),
    request: (token: string, documentId: string, startsAt: string) =>
      query(token, REQUEST_SQL, [documentId, startsAt]),
    transition: (
      token: string,
      documentId: string,
      slotId: string,
      action: SlotAction,
      startsAt: string | null,
    ) => query(token, TRANSITION_SQL, [documentId, slotId, action, startsAt]),
  };
}
