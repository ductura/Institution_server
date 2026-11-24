// SRV-MENTOR-3 (Ductus#2055; MK-8, MK-9, MK-11, PG-9): the database port of
// the note to self, the reading place, the seen marks and the mentor's
// overview (20261217100000). Each call is one withActor transaction over one
// RPC of schema collaboration; the RPCs decide who may: the student owner
// alone for the note and the reading place, the student and the teachers of
// the work for the seen marks, the mentor of an open mentorship for the
// overview (C-23). Nothing here reads or writes the document. The answer is a
// closed status, never a database message or SQLSTATE: ZD401 is
// unauthenticated, ZD403 not_found (one answer for "not yours", "not there"
// and "no relation"), ZD422 invalid, anything else unavailable. A row of an
// unexpected shape is unavailable too.
import type { ActorTransaction, WithActor } from "../index.ts";

export type WorkPlace = { readonly nodeId: string; readonly offset: number };
export type SelfNoteState = {
  readonly note: {
    readonly text: string;
    readonly place: WorkPlace | null;
    readonly updatedAt: string;
  } | null;
  readonly readingPlace: { readonly place: WorkPlace; readonly updatedAt: string } | null;
};
export type SeenKind = "comment" | "revision_request" | "milestone_revision" | "message";
export type SeenMark = {
  readonly kind: SeenKind;
  readonly id: string;
  readonly firstSeenAt: string;
};
export type MentorStudent = {
  readonly mentorshipId: string;
  readonly assignmentId: string;
  readonly documentId: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly workType: "bachelor_thesis" | "master_thesis" | "specialist_thesis" | "doctoral_thesis";
  readonly title: string;
  readonly stage: {
    readonly milestoneId: string;
    readonly title: string;
    readonly position: number;
    readonly state: "not_submitted" | "submitted" | "revision_requested";
  } | null;
  readonly stageCount: number;
  readonly waitingOn: "mentor" | "student" | "none";
  readonly nextDeadlineAt: string | null;
  readonly daysToNextDeadline: number | null;
  readonly newMessages: number;
};

export type FollowRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type Answer<T> = ({ readonly status: "ok" } & T) | FollowRefusal;

export type MentorshipFollow = {
  readSelfNote(token: string, documentId: string): Promise<Answer<{ state: SelfNoteState }>>;
  writeSelfNote(
    token: string,
    documentId: string,
    text: string,
    place: WorkPlace | null,
  ): Promise<Answer<{ state: SelfNoteState }>>;
  writeReadingPlace(
    token: string,
    documentId: string,
    place: WorkPlace,
  ): Promise<Answer<{ state: SelfNoteState }>>;
  clear(
    token: string,
    documentId: string,
    part: "note" | "reading",
  ): Promise<Answer<{ state: SelfNoteState }>>;
  markSeen(
    token: string,
    documentId: string,
    items: readonly { readonly kind: SeenKind; readonly id: string }[],
  ): Promise<Answer<{ items: SeenMark[] }>>;
  seenByStudent(token: string, documentId: string): Promise<Answer<{ items: SeenMark[] }>>;
  overview(token: string): Promise<Answer<{ students: MentorStudent[] }>>;
};

const NOTE_COLUMNS =
  'note_text AS "noteText", note_place AS "notePlace", note_updated_at AS "noteUpdatedAt", reading_place AS "readingPlace", reading_updated_at AS "readingUpdatedAt"';
const SQL = {
  read: `SELECT ${NOTE_COLUMNS} FROM collaboration.get_work_self_note($1)`,
  writeNote: `SELECT ${NOTE_COLUMNS} FROM collaboration.set_work_self_note($1, $2, $3::jsonb)`,
  writeReading: `SELECT ${NOTE_COLUMNS} FROM collaboration.set_work_reading_place($1, $2::jsonb)`,
  clear: `SELECT ${NOTE_COLUMNS} FROM collaboration.clear_work_self_note($1, $2)`,
  mark: 'SELECT item_kind AS "itemKind", item_id AS "itemId", first_seen_at AS "firstSeenAt" FROM collaboration.mark_work_items_seen($1, $2::text[], $3::uuid[])',
  seen: 'SELECT item_kind AS "itemKind", item_id AS "itemId", first_seen_at AS "firstSeenAt" FROM collaboration.list_work_items_seen_by_student($1) LIMIT $2',
  overview:
    'SELECT mentorship_id AS "mentorshipId", assignment_id AS "assignmentId", document_id AS "documentId", given_name AS "givenName", family_name AS "familyName", work_type AS "workType", title, stage_milestone_id AS "stageMilestoneId", stage_title AS "stageTitle", stage_position AS "stagePosition", stage_count AS "stageCount", stage_state AS "stageState", waiting_on AS "waitingOn", next_deadline_at AS "nextDeadlineAt", days_to_next_deadline AS "daysToNextDeadline", new_messages AS "newMessages" FROM collaboration.mentor_student_overview()',
} as const;

/** The most marks one read answers; the contract's SEEN_MARKS_MAX. */
export const SEEN_READ_LIMIT = 5000;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): FollowRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function instant(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
}

function place(value: unknown): WorkPlace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Malformed();
  const { nodeId, offset } = value as Record<string, unknown>;
  if (typeof nodeId !== "string" || !Number.isInteger(offset) || Object.keys(value).length !== 2) {
    throw new Malformed();
  }
  return { nodeId, offset: offset as number };
}

/** No row is nothing kept; one row is what the owner keeps. */
function toState(rows: readonly Record<string, unknown>[]): SelfNoteState {
  if (rows.length === 0) return { note: null, readingPlace: null };
  if (rows.length !== 1) throw new Malformed();
  const row = rows[0]!;
  const text = row["noteText"];
  if (text !== null && typeof text !== "string") throw new Malformed();
  return {
    note:
      text === null
        ? null
        : {
            text,
            place: row["notePlace"] === null ? null : place(row["notePlace"]),
            updatedAt: instant(row["noteUpdatedAt"]),
          },
    readingPlace:
      row["readingPlace"] === null
        ? null
        : { place: place(row["readingPlace"]), updatedAt: instant(row["readingUpdatedAt"]) },
  };
}

const KINDS: readonly unknown[] = ["comment", "revision_request", "milestone_revision", "message"];

function toMark(row: Record<string, unknown>): SeenMark {
  const kind = row["itemKind"];
  const id = row["itemId"];
  if (!KINDS.includes(kind) || typeof id !== "string") throw new Malformed();
  return { kind: kind as SeenKind, id, firstSeenAt: instant(row["firstSeenAt"]) };
}

const WORK_TYPES: readonly unknown[] = [
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
];
const STAGE_STATES: readonly unknown[] = ["not_submitted", "submitted", "revision_requested"];
const WAITING: readonly unknown[] = ["mentor", "student", "none"];

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Malformed();
  return value;
};
const textOrNull = (value: unknown): string | null => (value === null ? null : text(value));
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value)) throw new Malformed();
  return value as number;
};

function toStudent(row: Record<string, unknown>): MentorStudent {
  const workType = row["workType"];
  const waitingOn = row["waitingOn"];
  if (!WORK_TYPES.includes(workType) || !WAITING.includes(waitingOn)) throw new Malformed();
  let stage: MentorStudent["stage"] = null;
  if (row["stageMilestoneId"] !== null) {
    const state = row["stageState"];
    if (!STAGE_STATES.includes(state)) throw new Malformed();
    stage = {
      milestoneId: text(row["stageMilestoneId"]),
      title: text(row["stageTitle"]),
      position: integer(row["stagePosition"]),
      state: state as "not_submitted" | "submitted" | "revision_requested",
    };
  }
  const due = row["nextDeadlineAt"];
  return {
    mentorshipId: text(row["mentorshipId"]),
    assignmentId: text(row["assignmentId"]),
    documentId: textOrNull(row["documentId"]),
    givenName: textOrNull(row["givenName"]),
    familyName: textOrNull(row["familyName"]),
    workType: workType as MentorStudent["workType"],
    title: text(row["title"]),
    stage,
    stageCount: integer(row["stageCount"]),
    waitingOn: waitingOn as MentorStudent["waitingOn"],
    nextDeadlineAt: due === null ? null : instant(due),
    daysToNextDeadline:
      row["daysToNextDeadline"] === null ? null : integer(row["daysToNextDeadline"]),
    newMessages: integer(row["newMessages"]),
  };
}

export function createMentorshipFollow(withActor: WithActor): MentorshipFollow {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | FollowRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;
  const state = (token: string, sql: string, params: unknown[]) =>
    run(token, async (tx) => ({
      status: "ok" as const,
      state: toState(await rowsOf(tx, sql, params)),
    }));

  return {
    readSelfNote: (token, documentId) => state(token, SQL.read, [documentId]),
    writeSelfNote: (token, documentId, note, at) =>
      state(token, SQL.writeNote, [documentId, note, at === null ? null : JSON.stringify(at)]),
    writeReadingPlace: (token, documentId, at) =>
      state(token, SQL.writeReading, [documentId, JSON.stringify(at)]),
    clear: (token, documentId, part) => state(token, SQL.clear, [documentId, part]),
    markSeen: (token, documentId, items) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        items: (
          await rowsOf(tx, SQL.mark, [
            documentId,
            items.map((item) => item.kind),
            items.map((item) => item.id),
          ])
        ).map(toMark),
      })),
    seenByStudent: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        items: (await rowsOf(tx, SQL.seen, [documentId, SEEN_READ_LIMIT])).map(toMark),
      })),
    overview: (token) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        students: (await rowsOf(tx, SQL.overview, [])).map(toStudent),
      })),
  };
}
