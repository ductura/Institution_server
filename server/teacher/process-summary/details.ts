import type { Operations } from "../../contracts/generated/index.ts";
import type { EvidenceSegment } from "../../domain/index.ts";

const MINUTE_MS = 60_000;
export type ProcessSummaryV1 = Operations["projection.process-summary.post"]["success"]["body"];

type Span = { from: number; to: number };

function durationOutsideGaps(session: Span, sortedGaps: readonly Span[]): number {
  let cursor = session.from;
  let duration = 0;
  for (const gap of sortedGaps) {
    if (gap.to <= cursor) continue;
    if (gap.from >= session.to) break;
    duration += Math.max(0, gap.from - cursor);
    cursor = Math.min(session.to, gap.to);
  }
  return (duration + session.to - cursor) / MINUTE_MS;
}

export function processSummaryDetails(
  summary: ProcessSummaryV1,
  segments: readonly EvidenceSegment[],
) {
  const gaps = summary.gaps.items
    .map(({ previousEndedAt, nextStartedAt }) => ({
      from: Date.parse(previousEndedAt),
      to: Date.parse(nextStartedAt),
    }))
    .filter(({ from, to }) => from < to)
    .sort((left, right) => left.from - right.from);
  return {
    summary,
    activeEditingMinutes: summary.sessions.items.reduce(
      (total, { from, to }) =>
        total + durationOutsideGaps({ from: Date.parse(from), to: Date.parse(to) }, gaps),
      0,
    ),
    keyEvents: segments.flatMap((segment) =>
      segment.events.flatMap(({ source }) =>
        source === "import" || source === "ai-transfer"
          ? [{ kind: source, at: { from: segment.observedStartedAt, to: segment.observedEndedAt } }]
          : [],
      ),
    ),
  };
}
