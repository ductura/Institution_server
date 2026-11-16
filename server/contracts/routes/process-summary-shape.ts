import { Type } from "@sinclair/typebox";

import { closed } from "../schema/index.ts";

// ProcessSummaryV1 of Ductus 078c780 (src/domain/projection/process-summary.ts,
// B-13): the one summary built from the accepted evidence, the same for the
// student and the teacher (PRODUCT §5 rule 5). No total of pasted text, no
// share of the work, no speed, no pause length. Shared by the fast path and
// the process-summary route.

/** A whole UTC minute (D-24). */
export const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
const Count = (minimum: number) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
const MinuteSpan = closed({ from: Minute, to: Minute });

export const ProcessSummaryV1 = closed({
  summaryFormat: Type.Literal("ductus-process-summary-v1"),
  sessions: closed({
    evidenceKind: Type.Literal("observed"),
    breakAboveMinutes: Count(1),
    count: Count(0),
    items: Type.Array(MinuteSpan),
  }),
  pastes: closed({
    evidenceKind: Type.Literal("observed"),
    listedAboveCharacters: Count(0),
    listed: Type.Array(
      closed({ at: MinuteSpan, characters: Count(0), origin: Type.Literal("not_observed") }),
    ),
    smallerCount: Count(0),
  }),
  gaps: closed({
    evidenceKind: Type.Literal("observed"),
    items: Type.Array(closed({ previousEndedAt: Minute, nextStartedAt: Minute })),
  }),
  recordState: Type.Union([Type.Literal("complete"), Type.Literal("has_gaps")]),
});
