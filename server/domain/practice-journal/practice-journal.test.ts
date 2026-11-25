import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  entriesThrough,
  isCalendarDate,
  isEntryHours,
  practiceEntriesSha256,
  validateNewEntry,
  validateNewPlacement,
  validateNewSignoff,
  type PracticeEntryFields,
} from "./index.ts";

// Every entry below is invented.
const A: PracticeEntryFields = {
  entryId: "00000000-0000-4000-8000-0000000000a1",
  date: "2026-11-02",
  hours: 7.5,
  text: "Izmišljeni zapis: upoznavanje s timom.",
  correctsEntryId: null,
};
const B: PracticeEntryFields = {
  entryId: "00000000-0000-4000-8000-0000000000a2",
  date: "2026-11-03",
  hours: 8,
  text: "Izmišljeni zapis: rad na izvješću.",
  correctsEntryId: null,
};

describe("practiceEntriesSha256", () => {
  it("is the SHA-256 of the JCS of the entries, keys in JCS order, hours without a trailing zero", () => {
    const jcs =
      `[{"correctsEntryId":null,"date":"2026-11-02","entryId":"${A.entryId}","hours":7.5,` +
      `"text":"${A.text}"},{"correctsEntryId":null,"date":"2026-11-03","entryId":"${B.entryId}",` +
      `"hours":8,"text":"${B.text}"}]`;
    expect(practiceEntriesSha256([A, B])).toBe(
      createHash("sha256").update(jcs, "utf8").digest("hex"),
    );
  });

  it("is the same for the same set and differs once a correction joins it", () => {
    const correction: PracticeEntryFields = {
      ...B,
      entryId: "00000000-0000-4000-8000-0000000000a3",
      correctsEntryId: B.entryId,
    };
    expect(practiceEntriesSha256([A, B])).toBe(practiceEntriesSha256([{ ...A }, { ...B }]));
    expect(practiceEntriesSha256([A, B, correction])).not.toBe(practiceEntriesSha256([A, B]));
    expect(practiceEntriesSha256([])).toBe(createHash("sha256").update("[]").digest("hex"));
  });

  it("ignores fields that are not part of an entry", () => {
    const extra = { ...A, createdAt: "2026-11-02T10:00:00.000Z" } as PracticeEntryFields;
    expect(practiceEntriesSha256([extra])).toBe(practiceEntriesSha256([A]));
  });
});

describe("entriesThrough", () => {
  it("keeps every entry dated on or before the date, in order", () => {
    expect(entriesThrough([A, B], "2026-11-02")).toEqual([A]);
    expect(entriesThrough([A, B], "2026-11-03")).toEqual([A, B]);
    expect(entriesThrough([A, B], "2026-11-01")).toEqual([]);
  });
});

describe("input checks", () => {
  it("knows which dates exist", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-30",
      "2027-02-29",
      "2026-04-31",
      "2026-13-01",
      "1999-12-31",
      "2100-01-01",
      "26-01-01",
    ]) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it("takes hours 0.5 to 12 in steps of 0.5", () => {
    for (const ok of [0.5, 1, 7.5, 12]) expect(isEntryHours(ok), String(ok)).toBe(true);
    for (const bad of [0, 0.25, 12.5, 13, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isEntryHours(bad), String(bad)).toBe(false);
    }
  });

  it("refuses a placement whose period is backwards or whose date does not exist", () => {
    const base = {
      mentorshipId: "m",
      organisationName: "Izmišljena organizacija",
      startsOn: "2026-10-01",
      endsOn: "2026-12-01",
    };
    expect(validateNewPlacement(base).ok).toBe(true);
    expect(validateNewPlacement({ ...base, startsOn: "2026-12-02" }).ok).toBe(false);
    expect(validateNewPlacement({ ...base, endsOn: "2026-02-30" }).ok).toBe(false);
    expect(validateNewPlacement({ ...base, organisationName: "é" }).ok).toBe(false);
  });

  it("refuses an entry or a signoff that is not NFC or has a date that does not exist", () => {
    expect(validateNewEntry({ date: "2026-11-02", hours: 4, text: "č" }).ok).toBe(true);
    expect(validateNewEntry({ date: "2026-11-02", hours: 4, text: "č" }).ok).toBe(false);
    expect(validateNewEntry({ date: "2026-02-30", hours: 4, text: "x" }).ok).toBe(false);
    expect(validateNewEntry({ date: "2026-11-02", hours: 4.2, text: "x" }).ok).toBe(false);
    expect(validateNewSignoff({ throughDate: "2026-11-02" }).ok).toBe(true);
    expect(validateNewSignoff({ throughDate: "2026-11-02", comment: "č" }).ok).toBe(false);
    expect(validateNewSignoff({ throughDate: "2026-02-30" }).ok).toBe(false);
  });
});
