// SRV-V19-DNEVNIK-RUTE (Ductus#2055; val 19): the SHA-256 of the set of entries
// a mentor's signoff covers. It is the same bytes the database computes in
// institution.practice_entries_digest (migration 20261219100000): the SHA-256
// (lower-case hex) of the UTF-8 bytes of the JCS (RFC 8785) of the array of the
// covered entries ordered by (date, insertion), each one the object
// {correctsEntryId, date, entryId, hours, text}. Nothing here ranks, scores or
// measures a student: it only names a set.
import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../forensics/index.ts";

export type PracticeEntryFields = {
  readonly entryId: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  /** 0.5 to 12 in steps of 0.5. */
  readonly hours: number;
  readonly text: string;
  readonly correctsEntryId: string | null;
};

/**
 * The digest of entries that are already in the order the database uses: by
 * date, then by the order they were added. The order is part of the digest, so
 * the same set in another order is another digest by design.
 */
export function practiceEntriesSha256(entries: readonly PracticeEntryFields[]): string {
  const covered = entries.map((entry) => ({
    correctsEntryId: entry.correctsEntryId,
    date: entry.date,
    entryId: entry.entryId,
    hours: entry.hours,
    text: entry.text,
  }));
  return createHash("sha256").update(canonicalizeJcs(covered), "utf8").digest("hex");
}

/** The entries a signoff through `throughDate` covers: every entry dated on or before it, order kept. */
export function entriesThrough(
  entries: readonly PracticeEntryFields[],
  throughDate: string,
): PracticeEntryFields[] {
  return entries.filter((entry) => entry.date <= throughDate);
}
