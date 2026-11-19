// The invented record of a work as teachers and the student see it: text
// blocks and the process summary (ductus-process-summary-v1). The fake keeps
// no evidence, so every work shows the same small, clearly invented record.
import type { Work } from "./state.ts";

export function processSummary(work: Work) {
  const to = work.lastChangeAt ?? "2026-10-02T09:00:00.000Z";
  return {
    summaryFormat: "ductus-process-summary-v1" as const,
    sessions: {
      evidenceKind: "observed" as const,
      breakAboveMinutes: 30,
      count: 1,
      items: [{ from: "2026-10-02T08:30:00.000Z", to }],
    },
    pastes: {
      evidenceKind: "observed" as const,
      listedAboveCharacters: 200,
      listed: [],
      smallerCount: 0,
    },
    gaps: { evidenceKind: "observed" as const, items: [] },
    recordState: "complete" as const,
  };
}

export function textBlocks() {
  return [
    { kind: "heading" as const, text: "Izmišljeni naslov rada" },
    { kind: "paragraph" as const, text: "Izmišljeni odlomak teksta za lokalni razvoj." },
  ];
}
