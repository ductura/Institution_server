// SRV-V19-DNEVNIK-RUTE: the checks of a practice journal input that need no
// clock and no database, so a refusal comes before a round trip. The contract
// (server/contracts/routes/practice-journal.ts) fixes the shape; what a pattern
// cannot say is here: a date that exists (not 30 February), the order of the
// period, NFC. What depends on the day or on the practice (not in the future,
// inside the period, the 400-entry limit) is decided by the database, which is
// the only one that knows them (docs/contracts/practice-journal-v1.md).
export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** True for a calendar date `YYYY-MM-DD` that exists, year 2000 to 2099 (as the tables). */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last;
}

/** Hours of one entry: 0.5 to 12 in steps of 0.5. */
export function isEntryHours(value: number): boolean {
  return (
    Number.isFinite(value) && value >= 0.5 && value <= 12 && value * 2 === Math.trunc(value * 2)
  );
}

function isNfc(value: string): boolean {
  return value.normalize("NFC") === value;
}

export type NewPlacement = {
  readonly mentorshipId: string;
  readonly organisationName: string;
  readonly startsOn: string;
  readonly endsOn: string;
};

export function validateNewPlacement(input: NewPlacement): ValidationResult<NewPlacement> {
  const ok =
    isNfc(input.organisationName) &&
    isCalendarDate(input.startsOn) &&
    isCalendarDate(input.endsOn) &&
    input.startsOn <= input.endsOn;
  return ok ? { ok, value: input } : { ok: false };
}

export type NewEntry = {
  readonly date: string;
  readonly hours: number;
  readonly text: string;
  readonly correctsEntryId?: string;
};

export function validateNewEntry(input: NewEntry): ValidationResult<NewEntry> {
  const ok = isCalendarDate(input.date) && isEntryHours(input.hours) && isNfc(input.text);
  return ok ? { ok, value: input } : { ok: false };
}

export type NewSignoff = { readonly throughDate: string; readonly comment?: string };

export function validateNewSignoff(input: NewSignoff): ValidationResult<NewSignoff> {
  const ok =
    isCalendarDate(input.throughDate) && (input.comment === undefined || isNfc(input.comment));
  return ok ? { ok, value: input } : { ok: false };
}
