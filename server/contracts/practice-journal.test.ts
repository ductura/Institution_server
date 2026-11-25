// SRV-V19-DNEVNIK-UGOVOR: the closed inputs of the practice journal. Bad and
// edge input is refused by the schema itself; the vectors cover the answers.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  PRACTICE_ENTRIES_MAX,
  practiceEntriesPost,
  practiceJournalRoutes,
  practicePlacementsPost,
  practiceSignoffsPost,
} from "./routes/index.ts";

const entry = { date: "2026-03-09", hours: 4, text: "Izmisljen opis." };
const okEntry = (body: unknown) => Value.Check(practiceEntriesPost.request.body!, body);

describe("practice journal contract", () => {
  it("has six routes, none of which changes an existing contract", () => {
    expect(practiceJournalRoutes.map((r) => r.id)).toEqual([
      "practice.placements.post",
      "practice.placements.get",
      "practice.entries.get",
      "practice.entries.post",
      "practice.signoffs.post",
      "practice.signoffs.get",
    ]);
    expect(PRACTICE_ENTRIES_MAX).toBe(400);
  });

  it("accepts a valid entry and a correction", () => {
    expect(okEntry(entry)).toBe(true);
    expect(okEntry({ ...entry, correctsEntryId: "00000000-0000-4000-8000-00000000a301" })).toBe(
      true,
    );
  });

  it.each([
    ["hours 0", { ...entry, hours: 0 }],
    ["hours 12.5", { ...entry, hours: 12.5 }],
    ["hours off the half step", { ...entry, hours: 7.3 }],
    ["blank text", { ...entry, text: " \n" }],
    ["text of 4001 points", { ...entry, text: "x".repeat(4001) }],
    ["bidi control", { ...entry, text: "a‮b" }],
    ["control character", { ...entry, text: "a\u0000b" }],
    ["impossible date", { ...entry, date: "2026-13-01" }],
    ["unknown field", { ...entry, extra: 1 }],
  ])("refuses %s", (_name, body) => {
    expect(okEntry(body)).toBe(false);
  });

  it("accepts text of exactly 4000 points with newline and tab", () => {
    expect(okEntry({ ...entry, text: "a\n\t".padEnd(4000, "b") })).toBe(true);
  });

  it("refuses a blank or oversized signoff comment and a placement without a period", () => {
    const sign = (b: unknown) => Value.Check(practiceSignoffsPost.request.body!, b);
    expect(sign({ throughDate: "2026-03-10" })).toBe(true);
    expect(sign({ throughDate: "2026-03-10", comment: " " })).toBe(false);
    expect(sign({ throughDate: "2026-03-10", comment: "x".repeat(1001) })).toBe(false);
    const place = (b: unknown) => Value.Check(practicePlacementsPost.request.body!, b);
    expect(
      place({
        mentorshipId: "nije-id",
        organisationName: "A",
        startsOn: "2026-03-02",
        endsOn: "2026-06-30",
      }),
    ).toBe(false);
    expect(
      place({
        mentorshipId: "00000000-0000-4000-8000-00000000a201",
        organisationName: "A",
        startsOn: "2026-03-02",
      }),
    ).toBe(false);
  });
});
