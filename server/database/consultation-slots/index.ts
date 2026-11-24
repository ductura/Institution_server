import type { ActorTransaction, WithActor } from "../index.ts";

type SlotRow = {
  id: string;
  startsAt: Date;
  proposedAt: Date;
  state: string;
  topic: string | null;
};
type SlotAction = "accept" | "confirm" | "counter";

// SRV-KONZ-STANJA: every answer is read from institution.consultation_slot_details
// (SRV-MENTOR-1), so it carries the topic. Only the three states of this
// contract are read: a withdrawn, declined or cancelled slot stays left out,
// as institution.consultation_slots leaves it out.
const COLUMNS = 'id, starts_at AS "startsAt", proposed_at AS "proposedAt", state, topic';
const OPEN = "state IN ('requested', 'countered', 'confirmed')";
const LIST_SQL = `SELECT ${COLUMNS} FROM institution.consultation_slot_details($1) WHERE ${OPEN} ORDER BY starts_at, id`;
const ONE_SQL = `SELECT ${COLUMNS} FROM institution.consultation_slot_details($1) WHERE id = $2::uuid AND ${OPEN}`;
const REQUEST_SQL =
  "SELECT institution.request_consultation_slot_detail($1, $2::timestamptz, $3::text, NULL::text, NULL::integer, NULL::integer) AS id";
const TRANSITION_SQL =
  "SELECT id FROM institution.act_on_consultation_slot($1, $2::uuid, $3, $4::timestamptz)";

async function read(tx: ActorTransaction, sql: string, values: readonly unknown[]) {
  const { rows } = await tx.query<SlotRow>(sql, values);
  return rows.map(({ id, startsAt, proposedAt, state, topic }) => ({
    id,
    startsAt: startsAt.toISOString(),
    proposedAt: proposedAt.toISOString(),
    state,
    topic,
  }));
}

/** The written slot as the list shows it, read in the same transaction as the write. */
async function written(tx: ActorTransaction, documentId: string, sql: string, values: unknown[]) {
  const { rows } = await tx.query<{ id: string }>(sql, values);
  if (rows.length !== 1) throw new Error("expected one consultation slot");
  return read(tx, ONE_SQL, [documentId, rows[0]!.id]);
}

export function createConsultationSlotStore(withActor: WithActor) {
  return {
    list: (token: string, documentId: string) =>
      withActor(token, (tx) => read(tx, LIST_SQL, [documentId])),
    request: (token: string, documentId: string, startsAt: string, topic: string | null) =>
      withActor(token, (tx) => written(tx, documentId, REQUEST_SQL, [documentId, startsAt, topic])),
    transition: (
      token: string,
      documentId: string,
      slotId: string,
      action: SlotAction,
      startsAt: string | null,
    ) =>
      withActor(token, (tx) =>
        written(tx, documentId, TRANSITION_SQL, [documentId, slotId, action, startsAt]),
      ),
  };
}
