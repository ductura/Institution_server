import type { WithActor } from "../index.ts";

/** The preparation as the database returns it: timestamps as the database writes them in JSON. */
type RawInterview = {
  invitedAt: string | null;
  questions: {
    id: string;
    paragraphRef: string | null;
    questionText: string;
    createdAt: string;
    mine: boolean;
  }[];
  explanations: { id: string; questionId: string | null; text: string; createdAt: string }[];
  appointment:
    { consultationSlotId: string; startsAt: string } | { place: string; at: string } | null;
  heldOn: string | null;
};
type RawQuestion = RawInterview["questions"][number];
type RawExplanation = RawInterview["explanations"][number];
/** A note attached to the interview, as the database answers it. */
type RawNote = {
  id: string;
  fileName: string;
  mediaType: "text/plain" | "application/pdf";
  byteSize: number;
  sha256: string;
  createdAt: string;
};
export type Appointment =
  { consultationSlotId: string; startsAt: string } | { place: string; at: string };
type Interview = Omit<RawInterview, "appointment"> & { appointment: Appointment | null };

const utc = (value: string): string => new Date(value).toISOString();
const utcOrNull = (value: string | null): string | null => (value === null ? null : utc(value));

function interview(raw: RawInterview): Interview {
  const appointment = raw.appointment;
  return {
    invitedAt: utcOrNull(raw.invitedAt),
    questions: raw.questions.map(question),
    explanations: raw.explanations.map(explanation),
    appointment:
      appointment === null
        ? null
        : "consultationSlotId" in appointment
          ? {
              consultationSlotId: appointment.consultationSlotId,
              startsAt: utc(appointment.startsAt),
            }
          : { place: appointment.place, at: utc(appointment.at) },
    heldOn: raw.heldOn,
  };
}
const question = (raw: RawQuestion): RawQuestion => ({ ...raw, createdAt: utc(raw.createdAt) });
const explanation = (raw: RawExplanation): RawExplanation => ({
  ...raw,
  createdAt: utc(raw.createdAt),
});

const GET_SQL = "SELECT institution.work_interview_get($1) AS result";
const ADD_QUESTION_SQL = "SELECT institution.add_work_interview_question($1, $2, $3) AS result";
const REMOVE_QUESTION_SQL =
  "SELECT institution.remove_work_interview_question($1, $2::uuid) AS result";
const INVITE_SQL = "SELECT institution.invite_work_interview($1) AS result";
const APPOINTMENT_SQL =
  "SELECT institution.set_work_interview_appointment($1, $2::uuid, $3, $4::timestamptz) AS result";
const HELD_SQL = "SELECT institution.mark_work_interview_held($1, $2::date) AS result";
const EXPLAIN_SQL = "SELECT institution.add_work_interview_explanation($1, $2::uuid, $3) AS result";
const NOTE_SQL = "SELECT institution.add_work_interview_note($1, $2, $3, $4::bytea) AS result";

export function createWorkInterviewStore(withActor: WithActor) {
  async function one<T>(token: string, sql: string, values: readonly unknown[]): Promise<T> {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<{ result: T }>(sql, values);
      if (rows.length !== 1) throw new Error("expected one work interview result");
      return rows[0]!.result;
    });
  }

  return {
    get: async (token: string, documentId: string) =>
      interview(await one<RawInterview>(token, GET_SQL, [documentId])),
    addQuestion: async (
      token: string,
      documentId: string,
      paragraphRef: string | null,
      questionText: string,
    ) =>
      question(
        await one<RawQuestion>(token, ADD_QUESTION_SQL, [documentId, paragraphRef, questionText]),
      ),
    removeQuestion: async (token: string, documentId: string, questionId: string) => {
      await one<unknown>(token, REMOVE_QUESTION_SQL, [documentId, questionId]);
    },
    invite: async (token: string, documentId: string) =>
      interview(await one<RawInterview>(token, INVITE_SQL, [documentId])),
    setAppointment: async (
      token: string,
      documentId: string,
      appointment: { consultationSlotId: string } | { place: string; at: string },
    ) =>
      interview(
        await one<RawInterview>(
          token,
          APPOINTMENT_SQL,
          "consultationSlotId" in appointment
            ? [documentId, appointment.consultationSlotId, null, null]
            : [documentId, null, appointment.place, appointment.at],
        ),
      ),
    markHeld: async (token: string, documentId: string, date: string) =>
      interview(await one<RawInterview>(token, HELD_SQL, [documentId, date])),
    addExplanation: async (
      token: string,
      documentId: string,
      questionId: string | null,
      text: string,
    ) => explanation(await one<RawExplanation>(token, EXPLAIN_SQL, [documentId, questionId, text])),
    addNote: async (
      token: string,
      documentId: string,
      note: { fileName: string; mediaType: RawNote["mediaType"]; content: Uint8Array },
    ) => {
      const raw = await one<RawNote>(token, NOTE_SQL, [
        documentId,
        note.fileName,
        note.mediaType,
        Buffer.from(note.content),
      ]);
      return { ...raw, createdAt: utc(raw.createdAt) };
    },
  };
}
