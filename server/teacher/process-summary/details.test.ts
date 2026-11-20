import { expect, it } from "vitest";

import { processSummaryDetails, type ProcessSummaryV1 } from "./details.ts";

const minute = (hm: string) => `2026-11-20T${hm}:00.000Z`;
const empty: ProcessSummaryV1 = {
  summaryFormat: "ductus-process-summary-v1",
  sessions: { evidenceKind: "observed", breakAboveMinutes: 30, count: 0, items: [] },
  pastes: { evidenceKind: "observed", listedAboveCharacters: 200, listed: [], smallerCount: 0 },
  gaps: { evidenceKind: "observed", items: [] },
  recordState: "complete",
};

it("uses the session spans and excludes the union of overlapping gaps inside them", () => {
  const observed: ProcessSummaryV1 = {
    ...empty,
    sessions: {
      ...empty.sessions,
      count: 2,
      items: [
        { from: minute("09:00"), to: minute("09:20") },
        { from: minute("10:00"), to: minute("10:05") },
      ],
    },
    gaps: {
      evidenceKind: "observed",
      items: [
        { previousEndedAt: minute("09:10"), nextStartedAt: minute("09:15") },
        { previousEndedAt: minute("08:55"), nextStartedAt: minute("09:12") },
        { previousEndedAt: minute("09:18"), nextStartedAt: minute("09:16") },
        { previousEndedAt: minute("09:30"), nextStartedAt: minute("09:50") },
      ],
    },
    recordState: "has_gaps",
  };
  expect(processSummaryDetails(observed, [])).toEqual({
    summary: observed,
    activeEditingMinutes: 10,
    keyEvents: [],
  });
});

it("reports zero when the accepted package has no edits", () => {
  expect(processSummaryDetails(empty, [])).toEqual({
    summary: empty,
    activeEditingMinutes: 0,
    keyEvents: [],
  });
});
