// SRV-V16-POPIS-FAKULTET: the theses of the faculty for the registrar's office,
// only through app.read_thesis_overview of 20261220140000_thesis_overview.sql.
// The RPC decides who may read (the administrator of the faculty) and raises
// ZD401, ZD403 or ZD422; this file maps rows to the contract shape and keeps the
// paging key. Read only.
import type { ActorTransaction as Tx, WithActor } from "../index.ts";

type Row = {
  mentorshipId: string;
  documentId: string | null;
  workType: string;
  mentorGiven: string | null;
  mentorFamily: string | null;
  studentGiven: string | null;
  studentFamily: string | null;
  stage: string;
  defenseAt: Date | null;
  topicState: string;
  committeeSize: number;
};

export type ThesisOverviewQuery = {
  readonly stage: string | null;
  readonly limit: number;
  /** The `next` of the previous page, or null for the first page. */
  readonly after: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The key of one row: its date of the defence (or none) and its mentorship id. */
export function encodeThesisOverviewCursor(defenseAt: Date | null, mentorshipId: string): string {
  return Buffer.from(
    `${defenseAt === null ? "-" : defenseAt.toISOString()}|${mentorshipId}`,
    "utf8",
  ).toString("base64url");
}

/** The key behind a cursor, or null when the cursor is none that this route wrote. */
export function decodeThesisOverviewCursor(
  cursor: string,
): { defenseAt: Date | null; mentorshipId: string } | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(cursor)) return null;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const [at, id, ...extra] = text.split("|");
  if (extra.length > 0 || at === undefined || id === undefined || !UUID.test(id)) return null;
  if (at === "-") return { defenseAt: null, mentorshipId: id };
  if (!INSTANT.test(at) || Number.isNaN(Date.parse(at))) return null;
  return { defenseAt: new Date(at), mentorshipId: id };
}

const name = (given: string | null, family: string | null) =>
  given === null || family === null ? null : { givenName: given, familyName: family };

const COLUMNS = `mentorship_id AS "mentorshipId", document_id AS "documentId", work_type AS "workType",
  mentor_given_name AS "mentorGiven", mentor_family_name AS "mentorFamily",
  student_given_name AS "studentGiven", student_family_name AS "studentFamily",
  stage, defense_at AS "defenseAt", topic_state AS "topicState", committee_size AS "committeeSize"`;

async function page(
  tx: Tx,
  query: ThesisOverviewQuery,
  key: ReturnType<typeof decodeThesisOverviewCursor>,
) {
  // The RPC returns one row more than the limit, which tells there is a next page.
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM app.read_thesis_overview($1, $2, $3, $4, $5)`,
    [query.stage, query.limit, key !== null, key?.defenseAt ?? null, key?.mentorshipId ?? null],
  );
  const kept = rows.slice(0, query.limit);
  const last = kept.at(-1);
  return {
    works: kept.map((row) => ({
      documentId: row.documentId,
      workType: row.workType,
      mentorName: name(row.mentorGiven, row.mentorFamily),
      studentName: name(row.studentGiven, row.studentFamily),
      stage: row.stage,
      defenseAt: row.defenseAt === null ? null : row.defenseAt.toISOString(),
      topicState: row.topicState,
      committeeSize: row.committeeSize,
    })),
    next:
      rows.length > query.limit && last !== undefined
        ? encodeThesisOverviewCursor(last.defenseAt, last.mentorshipId)
        : null,
  };
}

export function createThesisOverviewStore(withActor: WithActor) {
  return {
    /** A page of the theses; `after` must already be a cursor this route wrote. */
    overview: (token: string, query: ThesisOverviewQuery) => {
      const key = query.after === null ? null : decodeThesisOverviewCursor(query.after);
      if (query.after !== null && key === null) throw new Error("Invalid thesis overview cursor");
      return withActor(token, (tx) => page(tx, query, key));
    },
  };
}

export type ThesisOverviewStore = ReturnType<typeof createThesisOverviewStore>;
