// SRV-V19-DNEVNIK-RUTE (Ductus#2055; val 19): the adapter of the practice
// journal. Every call is one withActor transaction with one app.* RPC
// (migration 20261219100000): the client never writes a table. Who may do what
// is decided by the RPCs from the relation (the student of the practice, the
// mentor of its mentorship), never from a role alone, and another's, an unknown
// and a malformed practice all come back as ZD404. Dates are formatted by the
// database (`YYYY-MM-DD`) so no time zone touches them.
import { validateNewEntry, validateNewPlacement, validateNewSignoff } from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

type PlacementRow = {
  placementId: string;
  mentorshipId: string;
  organisationName: string;
  startsOn: string;
  endsOn: string;
  entryCount: number;
  signedThrough: string | null;
};
type EntryRow = {
  entryId: string;
  date: string;
  hours: string;
  text: string;
  correctsEntryId: string | null;
  createdAt: Date;
};
type SignoffRow = {
  signoffId: string;
  throughDate: string;
  entryCount: number;
  entriesSha256: string;
  comment: string | null;
  signedAt: Date;
  mentorId: string;
  mentorGivenName: string | null;
  mentorFamilyName: string | null;
};

const DATE = "'YYYY-MM-DD'";
const OPEN = "SELECT app.open_practice_placement($1::uuid, $2::text, $3::date, $4::date) AS id";
// The columns leave SQL under their camelCase names: snake_case stays in SQL.
const PLACEMENTS = `SELECT placement_id AS "placementId", mentorship_id AS "mentorshipId",
    organisation_name AS "organisationName", to_char(starts_on, ${DATE}) AS "startsOn",
    to_char(ends_on, ${DATE}) AS "endsOn", entry_count AS "entryCount",
    to_char(signed_through, ${DATE}) AS "signedThrough"
  FROM app.practice_placements()
  ORDER BY starts_on DESC, placement_id
  LIMIT 200`;
const SIGNOFF_COLUMNS = `signoff_id AS "signoffId", to_char(through_date, ${DATE}) AS "throughDate",
    entry_count AS "entryCount", entries_sha256 AS "entriesSha256", comment, signed_at AS "signedAt",
    mentor_id AS "mentorId", mentor_given_name AS "mentorGivenName",
    mentor_family_name AS "mentorFamilyName"`;
const SIGNOFFS = `SELECT ${SIGNOFF_COLUMNS} FROM app.practice_signoffs($1::uuid)`;
// Entries and signoffs come from one statement, so one snapshot: a signoff is
// never shown without the entries it covers. The functions give the order; the
// ordinality keeps it through the aggregate.
const ENTRIES_AND_SIGNOFFS = `SELECT
  (SELECT coalesce(json_agg(e ORDER BY e.ord), '[]'::json) FROM (
     SELECT entry_id AS "entryId", to_char(entry_date, ${DATE}) AS "date", hours::text AS "hours",
            body AS "text", corrects_entry_id AS "correctsEntryId", created_at AS "createdAt", f.ord AS ord
       FROM app.practice_entries($1::uuid) WITH ORDINALITY AS f(entry_id, entry_date, hours, body, corrects_entry_id, created_at, ord)
  ) e) AS entries,
  (SELECT coalesce(json_agg(g ORDER BY g.ord), '[]'::json) FROM (
     SELECT ${SIGNOFF_COLUMNS}, f.ord AS ord
       FROM app.practice_signoffs($1::uuid) WITH ORDINALITY AS f(signoff_id, through_date, entry_count, entries_sha256, comment, signed_at, mentor_id, mentor_given_name, mentor_family_name, ord)
  ) g) AS signoffs`;
const ADD_ENTRY =
  "SELECT app.add_practice_entry($1::uuid, $2::date, $3::numeric, $4::text, $5::uuid) AS id";
const SIGN = `SELECT signoff_id AS "signoffId", entry_count AS "entryCount", entries_sha256 AS "entriesSha256"
  FROM app.sign_practice_entries($1::uuid, $2::date, $3::text)`;

const placementOf = (row: PlacementRow) => ({ ...row });

const entryOf = (row: EntryRow) => ({
  entryId: row.entryId,
  date: row.date,
  hours: Number(row.hours),
  text: row.text,
  correctsEntryId: row.correctsEntryId,
  createdAt: row.createdAt.toISOString(),
});

const signoffOf = (row: SignoffRow) => {
  // A mentor without a name on record is not shown under an invented one:
  // the answer then fails its own contract check and reads as unavailable.
  if (row.mentorGivenName === null || row.mentorFamilyName === null) {
    throw new Error("signoff mentor without a name");
  }
  return {
    signoffId: row.signoffId,
    throughDate: row.throughDate,
    entryCount: row.entryCount,
    entriesSha256: row.entriesSha256,
    comment: row.comment,
    signedAt: row.signedAt.toISOString(),
    mentor: { id: row.mentorId, givenName: row.mentorGivenName, familyName: row.mentorFamilyName },
  };
};

export type PracticePlacement = ReturnType<typeof placementOf>;
export type PracticeEntry = ReturnType<typeof entryOf>;
export type PracticeSignoff = ReturnType<typeof signoffOf>;

/** The refusal the RPCs give for an input they would not accept, so the route answers 422 before a round trip. */
function invalidInput(): never {
  throw Object.assign(new Error("invalid input"), { code: "ZD422" });
}

export function createPracticeJournalStore(withActor: WithActor) {
  return {
    openPlacement: (
      token: string,
      input: { mentorshipId: string; organisationName: string; startsOn: string; endsOn: string },
    ) =>
      withActor(token, async (tx) => {
        if (!validateNewPlacement(input).ok) invalidInput();
        const { rows } = await tx.query<{ id: string }>(OPEN, [
          input.mentorshipId,
          input.organisationName,
          input.startsOn,
          input.endsOn,
        ]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing opened placement");
        return { placementId: rows[0].id };
      }),
    placements: (token: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<PlacementRow>(PLACEMENTS);
        return rows.map(placementOf);
      }),
    // Entries and signoffs are read in one transaction: one snapshot of the practice.
    entries: (token: string, placementId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{
          entries: (Omit<EntryRow, "createdAt"> & { createdAt: string })[];
          signoffs: (Omit<SignoffRow, "signedAt"> & { signedAt: string })[];
        }>(ENTRIES_AND_SIGNOFFS, [placementId]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing practice journal");
        return {
          entries: rows[0].entries.map((row) =>
            entryOf({ ...row, createdAt: new Date(row.createdAt) }),
          ),
          signoffs: rows[0].signoffs.map((row) =>
            signoffOf({ ...row, signedAt: new Date(row.signedAt) }),
          ),
        };
      }),
    addEntry: (
      token: string,
      placementId: string,
      input: { date: string; hours: number; text: string; correctsEntryId?: string },
    ) =>
      withActor(token, async (tx) => {
        if (!validateNewEntry(input).ok) invalidInput();
        const { rows } = await tx.query<{ id: string }>(ADD_ENTRY, [
          placementId,
          input.date,
          input.hours,
          input.text,
          input.correctsEntryId ?? null,
        ]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing added entry");
        return { entryId: rows[0].id };
      }),
    sign: (token: string, placementId: string, input: { throughDate: string; comment?: string }) =>
      withActor(token, async (tx) => {
        if (!validateNewSignoff(input).ok) invalidInput();
        const { rows } = await tx.query<{
          signoffId: string;
          entryCount: number;
          entriesSha256: string;
        }>(SIGN, [placementId, input.throughDate, input.comment ?? null]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing signoff");
        return rows[0];
      }),
    signoffs: (token: string, placementId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<SignoffRow>(SIGNOFFS, [placementId]);
        return rows.map(signoffOf);
      }),
  };
}
