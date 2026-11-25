// SRV-V19-DNEVNIK-UGOVOR (Ductus#2055; val 19, docs/nalazi/val19-razlika.md §5
// task 1): the contract of a professional practice journal kept beside an
// existing mentorship. A placement is a period at an organisation with exactly
// one mentor (the teacher of the mentorship); the student adds entries (date,
// hours, text) that are only ever added: a correction is a new entry that names
// the one it corrects. The mentor signs the entries up to a date; a signoff is a
// record of who signed which set (its JCS SHA-256) and when, not a qualified
// signature (OP-V19-1). Nothing here enters a grade or an export of a grade, and
// nothing ranks or sanctions a student. Another's, an unknown and a malformed
// placement all read the same 404 (C-23). The database (a later task) decides
// access; the contract only declares it. The text is in
// docs/contracts/practice-journal-v1.md.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const Uuid = `[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}`;
const Id = Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` });
/** A path id: the same shape, either case; a malformed one is the same 404. */
const IdParam = Type.String({ pattern: `^${Uuid}${END}` });
const DATE = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";
/** A calendar date, ISO 8601 (the database also rejects 30 February). */
const IsoDate = Type.String({ pattern: `^${DATE}${END}` });
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
const Sha256 = Type.String({ pattern: `^[0-9a-f]{64}${END}` });

/** The most entries of one placement. */
export const PRACTICE_ENTRIES_MAX = 400;
/** The most signoffs of one placement (one per entry date at the most, plus a margin). */
export const PRACTICE_SIGNOFFS_MAX = 500;
/** The most placements one answer lists. */
export const PRACTICE_PLACEMENTS_MAX = 200;

/** The characters of a person's text that are never accepted: control (but newline and tab) and bidi controls. */
const BODY_CHAR = `[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\uD800-\\uDFFF]`;
/** A text of 1 to 4000 code points that is not blank (NFC is asked of the database too). */
const EntryText = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|${BODY_CHAR}){1,4000}${END}`,
});
/** One line of 1 to 120 code points: the name of the organisation. */
const OrganisationName = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\uD800-\\uDFFF]){1,120}(?<!\\s)${END}`,
});
/** A comment with a signoff: up to 1000 code points, newline and tab allowed. */
const SignoffComment = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|${BODY_CHAR}){1,1000}${END}`,
});
/** A name of a person, one line. */
const PersonName = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,100}(?<!\\s)${END}`,
});
/** Hours of one entry: 0.5 to 12 in steps of 0.5 (a closed list of 24 values, so a validator needs no arithmetic). */
export const PRACTICE_ENTRY_HOURS = Array.from({ length: 24 }, (_, index) => (index + 1) / 2);
const Hours = Type.Union(PRACTICE_ENTRY_HOURS.map((hours) => Type.Literal(hours)));

const PlacementParams = closed({ placementId: IdParam });

const Placement = closed({
  placementId: Id,
  mentorshipId: Id,
  organisationName: OrganisationName,
  startsOn: IsoDate,
  endsOn: IsoDate,
  entryCount: Type.Integer({ minimum: 0, maximum: PRACTICE_ENTRIES_MAX }),
  /** The latest date a signoff covers, or null while none exists. */
  signedThrough: Type.Union([IsoDate, Type.Null()]),
});

const Entry = closed({
  entryId: Id,
  date: IsoDate,
  hours: Hours,
  text: EntryText,
  /** The entry this one corrects, or null. */
  correctsEntryId: Type.Union([Id, Type.Null()]),
  createdAt: Instant,
});

const Signoff = closed({
  signoffId: Id,
  throughDate: IsoDate,
  entryCount: Type.Integer({ minimum: 1, maximum: PRACTICE_ENTRIES_MAX }),
  /** JCS SHA-256 of the set of entries up to throughDate that existed when it was signed. */
  entriesSha256: Sha256,
  comment: Type.Union([SignoffComment, Type.Null()]),
  signedAt: Instant,
  mentor: closed({ id: Id, givenName: PersonName, familyName: PersonName }),
});

const noStore = ["cache-control"];
const refusals = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...refusals,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
];

export const practicePlacementsPost = defineRoute({
  id: "practice.placements.post",
  method: "POST",
  path: "/api/v1/practice/placements",
  inventory: "app/api/practice/placements/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor of an active mentorship opens a placement for its student: the organisation (one line, 1 to 120 code points) and the period (startsOn on or before endsOn). A mentorship id that is not a UUID is 422 invalid_input; one that is another's, unknown or ended reads 404. A student has no such call. The placement belongs to that mentorship and has that one mentor.",
  request: {
    body: closed({
      mentorshipId: IdParam,
      organisationName: OrganisationName,
      startsOn: IsoDate,
      endsOn: IsoDate,
    }),
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    {
      status: 201,
      description: "the created placement",
      body: closed({ placementId: Id }),
      headers: noStore,
    },
  ],
  errors: writeErrors,
});

export const practicePlacementsGet = defineRoute({
  id: "practice.placements.get",
  method: "GET",
  path: "/api/v1/practice/placements",
  inventory: "app/api/practice/placements/route.ts",
  access: "signed_in",
  summary:
    "The placements of the caller: a student reads their own, a teacher only those of mentorships they are the mentor of. Latest start first, then placementId. entryCount counts every entry, corrections included; signedThrough is the latest throughDate of a signoff (not a promise that every later-added entry up to it is signed), null while none exists. It is a list of facts: no hours total, no comparison, no state of good or bad.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the caller's placements, possibly none",
      body: closed({ placements: Type.Array(Placement, { maxItems: PRACTICE_PLACEMENTS_MAX }) }),
      headers: noStore,
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const practiceEntriesGet = defineRoute({
  id: "practice.entries.get",
  method: "GET",
  path: "/api/v1/practice/placements/{placementId}/entries",
  inventory: "app/api/practice/placements/[placementId]/entries/route.ts",
  access: "signed_in",
  summary:
    "The entries of a placement, oldest date first, then createdAt, then entryId, with the signoffs (latest first). Read by the student of the placement and its mentor, and by no one else; another's, an unknown or a malformed placement reads 404. A corrected entry stays listed; the entry that corrects it names it.",
  request: { params: PlacementParams },
  responses: [
    {
      status: 200,
      description: "the entries and the signoffs",
      body: closed({
        entries: Type.Array(Entry, { maxItems: PRACTICE_ENTRIES_MAX }),
        signoffs: Type.Array(Signoff, { maxItems: PRACTICE_SIGNOFFS_MAX }),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const practiceEntriesPost = defineRoute({
  id: "practice.entries.post",
  method: "POST",
  path: "/api/v1/practice/placements/{placementId}/entries",
  inventory: "app/api/practice/placements/[placementId]/entries/route.ts",
  access: "student",
  summary:
    "The student of the placement adds an entry: date (not in the future, inside the period), hours (0.5 to 12 in steps of 0.5), text (1 to 4000 code points) and, to correct an earlier entry of the same placement, correctsEntryId. Entries are only added: nothing is changed or removed, a signed entry stays as signed and a correction after a signoff needs a new signoff. A date outside the period is 409 placement_closed; the 401st entry is 409 conflict. The mentor and anyone else read 404.",
  request: {
    params: PlacementParams,
    body: closed({
      date: IsoDate,
      hours: Hours,
      text: EntryText,
      correctsEntryId: Type.Optional(IdParam),
    }),
    contentType: "application/json",
    maxBodyBytes: 32_768,
  },
  responses: [
    {
      status: 201,
      description: "the created entry",
      body: closed({ entryId: Id }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "placement_closed"), error(409, "conflict")],
});

export const practiceSignoffsPost = defineRoute({
  id: "practice.signoffs.post",
  method: "POST",
  path: "/api/v1/practice/placements/{placementId}/signoffs",
  inventory: "app/api/practice/placements/[placementId]/signoffs/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor signs every entry of the placement up to and including throughDate that exists now: the answer says how many and the JCS SHA-256 of that set. A signoff is a record in Ductura of who signed which set and when, with an optional comment (up to 1000 code points); it is not a qualified signature and is never withdrawn (a later signoff replaces it in the view, the earlier one stays in the history). throughDate must not be in the future and must lie inside the period of the placement, else 422 invalid_input; so signedThrough only ever names a date that was in the past and in the period when it was signed. Entries added later for a date up to it are corrections that need a new signoff: signedThrough does not say that every entry up to that date is signed, entryCount and entriesSha256 of the signoff say which were. With no entry to sign it is 409 nothing_to_sign. The student and anyone else read 404.",
  request: {
    params: PlacementParams,
    body: closed({ throughDate: IsoDate, comment: Type.Optional(SignoffComment) }),
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    {
      status: 201,
      description: "the created signoff",
      body: closed({
        signoffId: Id,
        entryCount: Type.Integer({ minimum: 1, maximum: PRACTICE_ENTRIES_MAX }),
        entriesSha256: Sha256,
      }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "nothing_to_sign")],
});

export const practiceSignoffsGet = defineRoute({
  id: "practice.signoffs.get",
  method: "GET",
  path: "/api/v1/practice/placements/{placementId}/signoffs",
  inventory: "app/api/practice/placements/[placementId]/signoffs/route.ts",
  access: "signed_in",
  summary:
    "The signoffs of a placement, latest first, then signoffId. The same answer for the student of the placement and its mentor; the mentor's private notes are never part of it. Another's, an unknown or a malformed placement reads 404.",
  request: { params: PlacementParams },
  responses: [
    {
      status: 200,
      description: "the signoffs, possibly none",
      body: closed({ signoffs: Type.Array(Signoff, { maxItems: PRACTICE_SIGNOFFS_MAX }) }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const practiceJournalRoutes = [
  practicePlacementsPost,
  practicePlacementsGet,
  practiceEntriesGet,
  practiceEntriesPost,
  practiceSignoffsPost,
  practiceSignoffsGet,
] as const;
