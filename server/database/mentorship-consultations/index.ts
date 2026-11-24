import type { ActorTransaction as Tx, WithActor } from "../index.ts";

// SRV-MENTOR-1 (NF-6: MK-7, MK-3, MK-10, MK-5): each call is RPCs of the main
// database in one transaction. The functions take the actor from the session
// bound to it and decide who may, refusing with ZD401, ZD403, ZD409, ZD422 or
// ZD503, which the HTTP adapter maps. A write answers what the matching read
// returns for the written row, read in the same transaction.

const OPEN_SQL = "SELECT app.open_mentorship($1::uuid, $2::text, $3::text) AS id";
const STUDENT_MENTORSHIPS_SQL = `SELECT mentorship_id, assignment_id, work_type, topic, mentor_id,
       given_name, family_name, started_at, opened_by
  FROM app.student_mentorships()`;
const NOTIFICATIONS_SQL = `SELECT id, mentorship_id, work_type, topic, given_name, family_name,
       created_at, read_at
  FROM institution.list_mentorship_notifications($1::uuid)`;
const SLOT_DETAILS_SQL = `SELECT id, starts_at, proposed_at, state, topic, closed_by, closed_reason,
       closed_at, preparation_text, preparation_changed_paragraphs, preparation_resolved_comments
  FROM institution.consultation_slot_details($1)`;
const REQUEST_SQL = `SELECT institution.request_consultation_slot_detail(
  $1, $2::timestamptz, $3::text, $4::text, $5::integer, $6::integer) AS id`;
const CLOSE_SQL =
  "SELECT institution.close_consultation_slot($1, $2::uuid, $3::text, $4::text) AS id";
const TASKS_SQL = `SELECT id, record_id, task_position, body, done, marked_at, created_at
  FROM collaboration.list_consultation_tasks($1)`;
const ADD_TASK_SQL = "SELECT collaboration.add_consultation_task($1, $2::uuid, $3::text) AS id";
const MARK_TASK_SQL =
  "SELECT collaboration.mark_consultation_task($1, $2::uuid, $3::boolean) AS id";

type Row = Record<string, unknown>;
type Name = { readonly givenName: string; readonly familyName: string } | null;

export type StudentMentorshipRow = {
  readonly mentorshipId: string;
  readonly assignmentId: string | null;
  readonly workType: string;
  readonly topic: string | null;
  readonly mentorId: string;
  readonly mentorName: Name;
  readonly startedAt: string;
  readonly openedBy: string;
};

export type MentorshipNotificationRow = {
  readonly id: string;
  readonly targetId: string;
  readonly workType: string;
  readonly topic: string | null;
  readonly mentorName: Name;
  readonly createdAt: string;
  readonly readAt: string | null;
};

export type SlotDetailRow = {
  readonly id: string;
  readonly startsAt: string;
  readonly proposedAt: string;
  readonly state: string;
  readonly topic: string | null;
  readonly closing: { by: string; reason: string | null; at: string } | null;
  readonly preparation: {
    text: string;
    changedParagraphs: number;
    resolvedComments: number;
  } | null;
};

export type ConsultationTaskRow = {
  readonly id: string;
  readonly recordId: string;
  readonly position: number;
  readonly text: string;
  readonly done: boolean;
  readonly markedAt: string | null;
  readonly createdAt: string;
};

export type SlotPreparation = {
  readonly text: string;
  readonly changedParagraphs: number;
  readonly resolvedComments: number;
};

const instant = (value: unknown): string => (value as Date).toISOString();
const maybeInstant = (value: unknown): string | null => (value === null ? null : instant(value));
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const nameOf = (given: unknown, family: unknown): Name =>
  typeof given === "string" && typeof family === "string"
    ? { givenName: given, familyName: family }
    : null;

const slotOf = (row: Row): SlotDetailRow => ({
  id: row.id as string,
  startsAt: instant(row.starts_at),
  proposedAt: instant(row.proposed_at),
  state: row.state as string,
  topic: text(row.topic),
  closing:
    row.closed_by === null
      ? null
      : {
          by: row.closed_by as string,
          reason: text(row.closed_reason),
          at: instant(row.closed_at),
        },
  preparation:
    row.preparation_text === null
      ? null
      : {
          text: row.preparation_text as string,
          changedParagraphs: row.preparation_changed_paragraphs as number,
          resolvedComments: row.preparation_resolved_comments as number,
        },
});

const taskOf = (row: Row): ConsultationTaskRow => ({
  id: row.id as string,
  recordId: row.record_id as string,
  position: row.task_position as number,
  text: row.body as string,
  done: row.done as boolean,
  markedAt: maybeInstant(row.marked_at),
  createdAt: instant(row.created_at),
});

async function idOf(tx: Tx, sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(sql, values);
  if (rows.length !== 1 || typeof rows[0]!.id !== "string") throw new Error("expected one id");
  return rows[0]!.id;
}

async function slot(tx: Tx, documentId: string, id: string): Promise<SlotDetailRow> {
  const { rows } = await tx.query<Row>(SLOT_DETAILS_SQL, [documentId]);
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error("written consultation slot not readable");
  return slotOf(row);
}

async function task(tx: Tx, documentId: string, id: string): Promise<ConsultationTaskRow> {
  const { rows } = await tx.query<Row>(TASKS_SQL, [documentId]);
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error("written consultation task not readable");
  return taskOf(row);
}

export function createMentorshipConsultationStore(withActor: WithActor) {
  return {
    /** MK-7: the teacher opens a mentorship; the id of the new mentorship. */
    open: (token: string, studentId: string, workType: string, topic: string | null) =>
      withActor(token, (tx) => idOf(tx, OPEN_SQL, [studentId, workType, topic])),
    /** The caller's open mentorships as their student, newest first. */
    studentMentorships: (token: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(STUDENT_MENTORSHIPS_SQL);
        return rows.map((row): StudentMentorshipRow => ({
          mentorshipId: row.mentorship_id as string,
          assignmentId: text(row.assignment_id),
          workType: row.work_type as string,
          topic: text(row.topic),
          mentorId: row.mentor_id as string,
          mentorName: nameOf(row.given_name, row.family_name),
          startedAt: instant(row.started_at),
          openedBy: row.opened_by as string,
        }));
      }),
    /** The caller's own notices of an opening; up to 51 rows, one more than a page. */
    notifications: (token: string, before: string | null) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(NOTIFICATIONS_SQL, [before]);
        return rows.map((row): MentorshipNotificationRow => ({
          id: row.id as string,
          targetId: row.mentorship_id as string,
          workType: row.work_type as string,
          topic: text(row.topic),
          mentorName: nameOf(row.given_name, row.family_name),
          createdAt: instant(row.created_at),
          readAt: maybeInstant(row.read_at),
        }));
      }),
    /** MK-3, MK-10: every slot of the work with topic, closing and preparation. */
    slots: (token: string, documentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(SLOT_DETAILS_SQL, [documentId]);
        return rows.map(slotOf);
      }),
    request: (
      token: string,
      documentId: string,
      startsAt: string,
      topic: string | null,
      preparation: SlotPreparation | null,
    ) =>
      withActor(token, async (tx) => {
        const id = await idOf(tx, REQUEST_SQL, [
          documentId,
          startsAt,
          topic,
          preparation?.text ?? null,
          preparation?.changedParagraphs ?? null,
          preparation?.resolvedComments ?? null,
        ]);
        return slot(tx, documentId, id);
      }),
    close: (
      token: string,
      documentId: string,
      slotId: string,
      action: string,
      reason: string | null,
    ) =>
      withActor(token, async (tx) => {
        const id = await idOf(tx, CLOSE_SQL, [documentId, slotId, action, reason]);
        return slot(tx, documentId, id);
      }),
    /** MK-5: the agreed tasks of the work's records. */
    tasks: (token: string, documentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(TASKS_SQL, [documentId]);
        return rows.map(taskOf);
      }),
    addTask: (token: string, documentId: string, recordId: string, body: string) =>
      withActor(token, async (tx) => {
        const id = await idOf(tx, ADD_TASK_SQL, [documentId, recordId, body]);
        return task(tx, documentId, id);
      }),
    markTask: (token: string, documentId: string, taskId: string, done: boolean) =>
      withActor(token, async (tx) => {
        const id = await idOf(tx, MARK_TASK_SQL, [documentId, taskId, done]);
        return task(tx, documentId, id);
      }),
  };
}
