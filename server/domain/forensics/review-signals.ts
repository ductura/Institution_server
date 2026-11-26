/**
 * P-2 review flags R-2 and R-3 recomputed by the server from the evidence it
 * already holds: verified segments and their `ductus-evidence-timing-v1`
 * records. PROPOSAL (docs/ductus/USTAV-DOPUNA-P2.md in ductura/.github,
 * status PRIJEDLOG): not wired into any route, tested on invented data only.
 *
 * Why on the server: flags computed in the student's browser are the
 * client's claim; a browser that is driven by a program can simply not send
 * them. The segments and timings are what the server verified and stored, so
 * a flag computed here does not depend on the client's good will. What it
 * still depends on is the client's attribution (`editor` is a claim, see
 * evidence-segment-v2.ts) and its offsets: a client that forges both can pass.
 *
 * CONFLICT WITH THE CURRENT RULES: evidence-timing-v1.ts says nothing built
 * on the timing computes a pause with a length (PRODUCT §5 rules 2 and 4).
 * This file does, so it may be used only after the constitution takes P-1
 * (rhythm of input, C-14, N-2) and P-2 (N-4). Until then demo and tests only.
 *
 * Pure: no clock, no I/O, no text kept. Counts characters, never reads them
 * into anything that leaves this function. R-1 (automated browser) is a fact
 * only the browser knows and stays the client's; R-4 waits for samples.
 */

import type { EvidenceSegment } from "./evidence-segment-v2.ts";
import type { EvidenceTimingV1 } from "./evidence-timing-v1.ts";

/** Same as the client (packages/editor-core review-signals.ts): P-1, 4 s. */
export const REVIEW_BURST_QUIET_MS = 4000;

/**
 * How far before the end of the typed text a change may start and still be a
 * correction of the last word. The client decides this from the document
 * (whitespace between the change and the end); the server has no document per
 * event, so it uses a fixed distance in positions. An approximation: the two
 * must be compared on samples before either is used (P-2 §5).
 */
export const LAST_WORD_SLACK = 24;

export type ServerReviewThresholds = Readonly<{
  r2MinChars: number;
  r2MaxPauseMs: number;
  r3MinChars: number;
  r3MaxRemoved: number;
}>;

/** PLACEHOLDERS, identical to the client's. Set from samples, never by hand. */
export const SERVER_PLACEHOLDER_THRESHOLDS: ServerReviewThresholds = Object.freeze({
  r2MinChars: 400,
  r2MaxPauseMs: 2000,
  r3MinChars: 400,
  r3MaxRemoved: 5,
});

export type ServerBurst = {
  /** Sequence of the first and last typed event of the burst. */
  sequenceFrom: number;
  sequenceTo: number;
  chars: number;
  longestPauseMs: number;
  wentBack: number;
  removed: number;
};

export type ServerReviewFlag = Readonly<
  | { rule: "R-2"; reason: "long-burst-without-pause"; sequenceFrom: number; sequenceTo: number }
  | { rule: "R-3"; reason: "linear-burst"; sequenceFrom: number; sequenceTo: number }
>;

export type ServerReviewResult = {
  flags: ServerReviewFlag[];
  bursts: ServerBurst[];
  /** Typed events in segments without a usable timing: not in any burst. */
  untimedTypingEvents: number;
};

/** One verified segment, in chain order, and its verified timing if any. */
export type ReviewEvidence = Readonly<{
  segment: EvidenceSegment;
  timing: EvidenceTimingV1 | null;
}>;

type Step = { [key: string]: unknown };

function codePointsIn(node: unknown): number {
  if (typeof node !== "object" || node === null) return 0;
  const record = node as Step;
  let count = typeof record.text === "string" ? [...record.text].length : 0;
  if (Array.isArray(record.content)) {
    for (const child of record.content) count += codePointsIn(child);
  }
  return count;
}

/** Characters a step inserts and positions it removes; 0, 0 for marks and attrs. */
function stepShape(step: Step): { from: number; inserted: number; removed: number } | null {
  if (step.stepType !== "replace" && step.stepType !== "replaceAround") return null;
  const from = Number(step.from);
  const to = Number(step.to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return null;
  return { from, inserted: codePointsIn(step.slice), removed: to - from };
}

/** Offsets of an event's steps, only if the timing describes exactly this segment. */
function offsetsBySequence(evidence: ReviewEvidence): Map<number, number[]> | null {
  const { segment, timing } = evidence;
  if (timing === null || timing.events.length !== segment.events.length) return null;
  const map = new Map<number, number[]>();
  for (let i = 0; i < segment.events.length; i++) {
    const event = segment.events[i]!;
    const timed = timing.events[i]!;
    if (timed.sequence !== event.sequence || timed.stepOffsetsMs.length !== event.steps.length) {
      return null;
    }
    map.set(event.sequence, timed.stepOffsetsMs);
  }
  return map;
}

/**
 * R-2 and R-3 for one writing session's evidence, by the rules of P-2 §3.
 * With the rhythm switched off for the task, R-2 is not computed (P-2 §4).
 * Only `editor` events enter the rhythm: assistive input (`keyless-input`)
 * and everything that is not typing never do.
 */
export function reviewFlagsFromEvidence(
  evidence: readonly ReviewEvidence[],
  context: Readonly<{ rhythmRecorded: boolean }>,
  t: ServerReviewThresholds = SERVER_PLACEHOLDER_THRESHOLDS,
): ServerReviewResult {
  const bursts: ServerBurst[] = [];
  let open: (ServerBurst & { endedAt: number }) | null = null;
  let frontier = 0;
  let untimedTypingEvents = 0;
  const close = () => {
    if (open) {
      const { sequenceFrom, sequenceTo, chars, longestPauseMs, wentBack, removed } = open;
      bursts.push({ sequenceFrom, sequenceTo, chars, longestPauseMs, wentBack, removed });
    }
    open = null;
  };

  for (const item of evidence) {
    const offsets = offsetsBySequence(item);
    const startedAt = Date.parse(item.segment.observedStartedAt);
    if (offsets === null) close();

    // One event of the capture layer can hold many keystrokes (its steps), each
    // with its own offset: the rhythm is read per step, so the time inside an
    // event is never taken for a pause (found on real Ductura evidence, Lab S06).
    for (const event of item.segment.events) {
      const typed = event.source === "editor";
      const stepOffsets = offsets?.get(event.sequence);
      if (typed && offsets === null) untimedTypingEvents += 1;
      event.steps.forEach((raw, index) => {
        const shape = stepShape(raw as Step);
        if (!shape) return;
        const wentBack = typed && shape.from < frontier - LAST_WORD_SLACK;
        // Every change moves the end of the typed text if it lies before it.
        if (shape.from < frontier)
          frontier = Math.max(shape.from, frontier + shape.inserted - shape.removed);
        if (typed) frontier = Math.max(frontier, shape.from + shape.inserted);
        if (!typed || offsets === null) return;
        const at = startedAt + (stepOffsets?.[index] ?? 0);
        const current: (ServerBurst & { endedAt: number }) | null = open;
        if (current && at - current.endedAt <= REVIEW_BURST_QUIET_MS) {
          current.longestPauseMs = Math.max(
            current.longestPauseMs,
            Math.max(0, at - current.endedAt),
          );
          current.endedAt = Math.max(current.endedAt, at);
          current.sequenceTo = event.sequence;
          current.chars += shape.inserted;
          current.removed += shape.removed;
          if (wentBack) current.wentBack += 1;
        } else {
          close();
          open = {
            sequenceFrom: event.sequence,
            sequenceTo: event.sequence,
            chars: shape.inserted,
            longestPauseMs: 0,
            wentBack: wentBack ? 1 : 0,
            removed: shape.removed,
            endedAt: at,
          };
        }
      });
    }
  }
  close();

  const flags: ServerReviewFlag[] = [];
  for (const b of bursts) {
    const where = { sequenceFrom: b.sequenceFrom, sequenceTo: b.sequenceTo };
    if (context.rhythmRecorded && b.chars >= t.r2MinChars && b.longestPauseMs <= t.r2MaxPauseMs) {
      flags.push({ rule: "R-2", reason: "long-burst-without-pause", ...where });
    }
    if (b.chars >= t.r3MinChars && b.wentBack === 0 && b.removed <= t.r3MaxRemoved) {
      flags.push({ rule: "R-3", reason: "linear-burst", ...where });
    }
  }
  return { flags, bursts, untimedTypingEvents };
}
