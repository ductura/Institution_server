// The port of a student's amendments and disputes of process summary events
// (SRV-1314, plan M7.8, R-08; migration 20261210105000). The student who owns
// the work adds a record that names one event of the summary by its id; a
// reader of the work (teacher of the course, of the seminar group, mentor)
// reads them. A record is append-only and never changes the signed receipt
// or the event: it lives beside them. Every write goes through an RPC, never
// the table, and the student and institution come only from the session.
//
// The input is checked here before the database checks it again. Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23: another's work and a work that does not exist alike),
// ZD422 invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

export const EVENT_DISPUTE_KINDS = ["amendment", "dispute"] as const;
export type EventDisputeKind = (typeof EVENT_DISPUTE_KINDS)[number];

/** The bounds of the migration's CHECK constraints. */
const TEXT_MAX = 1000;
const EVENT_ID = /^[a-z][a-z0-9_.:/-]{0,127}$/u;
const NOT_BLANK = /\S/u;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type EventDispute = {
  readonly id: string;
  readonly kind: EventDisputeKind;
  readonly eventId: string;
  readonly text: string;
  readonly createdAt: string;
};

export type EventDisputeInput = {
  readonly assignmentId: string;
  readonly kind: string;
  readonly eventId: string;
  readonly text: string;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type EventDisputeAdd =
  | { readonly status: "added"; readonly record: EventDispute }
  | Refusal
  | { readonly status: "invalid_input" };
export type EventDisputeList =
  { readonly status: "read"; readonly records: EventDispute[] } | Refusal;

const FIELDS = 'id, kind, event_id AS "eventId", text, created_at AS "createdAt"';
const ADD_SQL = `SELECT ${FIELDS} FROM app.add_event_dispute($1::uuid, $2::text, $3::text, $4::text)`;
const LIST_SQL = `SELECT ${FIELDS} FROM app.event_disputes($1::uuid, $2::uuid) ORDER BY created_at, id`;

const ADD_WORK_SQL = `SELECT ${FIELDS} FROM app.add_work_event_dispute($1::text, $2::text, $3::text, $4::text)`;
const LIST_WORK_SQL = `SELECT ${FIELDS} FROM app.work_event_disputes($1::text) ORDER BY created_at, id`;

type Row = { id: unknown; kind: unknown; eventId: unknown; text: unknown; createdAt: unknown };

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);
const isKind = (value: unknown): value is EventDisputeKind =>
  (EVENT_DISPUTE_KINDS as readonly unknown[]).includes(value);
const isEventId = (value: unknown): value is string =>
  typeof value === "string" && EVENT_ID.test(value);
/** 1 to 1000 code points, at least one not blank: the database counts code points too. */
const isText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  [...value].length <= TEXT_MAX &&
  NOT_BLANK.test(value);

function recordOf(row: Row): EventDispute {
  if (
    !isId(row.id) ||
    !isKind(row.kind) ||
    !isEventId(row.eventId) ||
    !isText(row.text) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  ) {
    throw new Error("invalid event dispute row");
  }
  return {
    id: row.id,
    kind: row.kind,
    eventId: row.eventId,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(code: unknown): Refusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

export type EventDisputeWorkInput = {
  readonly kind: string;
  readonly eventId: string;
  readonly text: string;
};

export function createEventDisputes(withActor: WithActor) {
  async function add(token: string, sql: string, args: string[], input: EventDisputeWorkInput) {
    try {
      return await withActor(token, async (tx): Promise<EventDisputeAdd> => {
        const { rows } = await tx.query<Row>(sql, args);
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) throw new Error("unconfirmed event dispute");
        const record = recordOf(row);
        if (
          record.kind !== input.kind ||
          record.eventId !== input.eventId ||
          record.text !== input.text
        ) {
          throw new Error("unconfirmed event dispute");
        }
        return { status: "added", record };
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD422") return { status: "invalid_input" } as const;
      const refusal = refusalOf(code);
      if (refusal !== undefined) return refusal;
      throw error;
    }
  }
  return {
    /**
     * The owner of the work (named by its document id) adds a record; a reader
     * of the work who is not its owner, and anyone else, is not_found.
     */
    async addToWork(
      token: string,
      documentId: string,
      input: EventDisputeWorkInput,
    ): Promise<EventDisputeAdd> {
      if (!isKind(input.kind) || !isEventId(input.eventId) || !isText(input.text)) {
        return { status: "invalid_input" };
      }
      return add(token, ADD_WORK_SQL, [documentId, input.kind, input.eventId, input.text], input);
    },
    /** The records of a work for its owner or a reader of it, oldest first. */
    async listForWork(token: string, documentId: string): Promise<EventDisputeList> {
      try {
        return await withActor(token, async (tx): Promise<EventDisputeList> => {
          const { rows } = await tx.query<Row>(LIST_WORK_SQL, [documentId]);
          return { status: "read", records: rows.map(recordOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The student who owns the work amends or disputes an event of its summary. */
    async add(token: string, input: EventDisputeInput): Promise<EventDisputeAdd> {
      if (
        !isId(input.assignmentId) ||
        !isKind(input.kind) ||
        !isEventId(input.eventId) ||
        !isText(input.text)
      ) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(ADD_SQL, [
            input.assignmentId,
            input.kind,
            input.eventId,
            input.text,
          ]);
          const row = rows[0];
          // Confirmed inside the transaction, so an answer that is not this
          // record rolls the write back.
          if (rows.length !== 1 || row === undefined) {
            throw new Error("unconfirmed event dispute");
          }
          const record = recordOf(row);
          if (
            record.kind !== input.kind ||
            record.eventId !== input.eventId ||
            record.text !== input.text
          ) {
            throw new Error("unconfirmed event dispute");
          }
          return { status: "added", record };
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = refusalOf(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /**
     * The records of one student on an assignment, oldest first: the caller's
     * own with a null student, else for a reader of that student's work.
     */
    async list(
      token: string,
      assignmentId: string,
      studentId: string | null = null,
    ): Promise<EventDisputeList> {
      if (!isId(assignmentId) || (studentId !== null && !isId(studentId))) {
        return { status: "not_found" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(LIST_SQL, [assignmentId, studentId]);
          return { status: "read", records: rows.map(recordOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type EventDisputes = ReturnType<typeof createEventDisputes>;
