// The consultation records of one work and their additions (SRV-1105,
// Ductus#2051; N-12, D-47, PO-22). Who asks comes only from the session token
// bound into withActor; the three functions of collaboration decide access
// with the relation of the comments (the teacher of the assignment or the
// student who owns the work), answer for another's work as for a missing one
// (ZD403, C-23) and check the revision against the same work. Nothing here
// updates or deletes: a record and an addition are only added.
import type { WithActor } from "../index.ts";

export type Addition = {
  readonly id: string;
  readonly text: string;
  /** A whole UTC minute (D-24). */
  readonly createdAt: string;
};
export type ConsultationRecord = {
  readonly id: string;
  /** YYYY-MM-DD. */
  readonly heldOn: string;
  readonly revision: number;
  readonly topic: string;
  readonly agreement: string;
  readonly additions: readonly Addition[];
};
export type RecordInput = {
  readonly heldOn: string;
  readonly revision: number;
  readonly topic: string;
  readonly agreement: string;
};
type Refusal = { readonly status: "unauthenticated" | "not_found" | "invalid_input" };
export type ListAnswer =
  | { readonly status: "ok"; readonly records: readonly ConsultationRecord[] }
  | Refusal
  | { readonly status: "unavailable" };
export type CreateAnswer =
  | { readonly status: "ok"; readonly record: ConsultationRecord }
  | Refusal
  | { readonly status: "unavailable" };
export type AddAnswer =
  | { readonly status: "ok"; readonly addition: Addition }
  | Refusal
  | { readonly status: "unavailable" };

export type ConsultationRecords = {
  list(token: string, documentId: string): Promise<ListAnswer>;
  create(token: string, documentId: string, input: RecordInput): Promise<CreateAnswer>;
  addAddition(
    token: string,
    documentId: string,
    recordId: string,
    text: string,
  ): Promise<AddAnswer>;
};

type Row = Record<string, unknown>;

const LIST = `SELECT record_id AS "recordId", to_char(held_on, 'YYYY-MM-DD') AS "heldOn",
    revision::text AS revision, topic, agreement, addition_id AS "additionId",
    addition_body AS "additionBody", addition_minute AS "additionMinute"
  FROM collaboration.list_consultation_records($1)`;
const CREATE =
  "SELECT collaboration.create_consultation_record($1, $2::date, $3::bigint, $4, $5) AS id";
const ADD = `SELECT addition_id AS id, addition_minute AS "createdAt"
  FROM collaboration.add_consultation_addition($1, $2::uuid, $3)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const REVISION = /^[1-9][0-9]{0,15}$/u;
const REFUSALS = new Map<string, Refusal["status"]>([
  ["ZD401", "unauthenticated"],
  ["ZD403", "not_found"],
  ["ZD422", "invalid_input"],
]);

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(thrown: unknown): Refusal | null {
  const code = codeOf(thrown);
  const status = typeof code === "string" ? REFUSALS.get(code) : undefined;
  return status === undefined ? null : { status };
}

/** A date that exists in the calendar, as YYYY-MM-DD. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function minuteOf(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.getTime() % 60_000 === 0 ? value.toISOString() : null;
}

/** The rows of the list, grouped by record in the order the function gives them, or null if any is not what it returns. */
export function recordsOf(rows: readonly Row[]): ConsultationRecord[] | null {
  const records: { -readonly [K in keyof ConsultationRecord]: ConsultationRecord[K] }[] = [];
  const additions = new Map<string, Addition[]>();
  for (const row of rows) {
    const { recordId, heldOn, revision, topic, agreement } = row;
    if (
      typeof recordId !== "string" ||
      !UUID.test(recordId) ||
      !isCalendarDate(heldOn) ||
      typeof revision !== "string" ||
      !REVISION.test(revision) ||
      !Number.isSafeInteger(Number(revision)) ||
      typeof topic !== "string" ||
      typeof agreement !== "string"
    ) {
      return null;
    }
    let list = additions.get(recordId);
    if (list === undefined) {
      list = [];
      additions.set(recordId, list);
      records.push({
        id: recordId,
        heldOn,
        revision: Number(revision),
        topic,
        agreement,
        additions: list,
      });
    }
    if (row.additionId !== null) {
      const createdAt = minuteOf(row.additionMinute);
      if (
        typeof row.additionId !== "string" ||
        !UUID.test(row.additionId) ||
        typeof row.additionBody !== "string" ||
        createdAt === null
      ) {
        return null;
      }
      list.push({ id: row.additionId, text: row.additionBody, createdAt });
    }
  }
  return records;
}

export function createConsultationRecords(withActor: WithActor): ConsultationRecords {
  return {
    async list(token, documentId) {
      try {
        const { rows } = await withActor(token, (tx) => tx.query<Row>(LIST, [documentId]));
        const records = recordsOf(rows);
        return records === null ? { status: "unavailable" } : { status: "ok", records };
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        return refusal;
      }
    },
    async create(token, documentId, input) {
      if (
        !isCalendarDate(input.heldOn) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1
      ) {
        return { status: "invalid_input" };
      }
      try {
        const { rows } = await withActor(token, (tx) =>
          tx.query<Row>(CREATE, [
            documentId,
            input.heldOn,
            input.revision,
            input.topic,
            input.agreement,
          ]),
        );
        const id = rows.length === 1 ? rows[0]?.id : undefined;
        if (typeof id !== "string" || !UUID.test(id)) return { status: "unavailable" };
        return { status: "ok", record: { id, ...input, additions: [] } };
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        return refusal;
      }
    },
    async addAddition(token, documentId, recordId, text) {
      try {
        const { rows } = await withActor(token, (tx) =>
          tx.query<Row>(ADD, [documentId, recordId, text]),
        );
        const row = rows.length === 1 ? rows[0] : undefined;
        const createdAt = minuteOf(row?.createdAt);
        if (typeof row?.id !== "string" || !UUID.test(row.id) || createdAt === null) {
          return { status: "unavailable" };
        }
        return { status: "ok", addition: { id: row.id, text, createdAt } };
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        return refusal;
      }
    },
  };
}
