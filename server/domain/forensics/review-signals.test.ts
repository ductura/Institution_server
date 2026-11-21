// PROPOSAL tests for reviewFlagsFromEvidence (P-2, status PRIJEDLOG): invented
// segments and timings, built here as already verified values. Hashes are
// placeholders: the function reads only sources, steps and offsets.
import { describe, expect, it } from "vitest";

import type { EvidenceSegment } from "./evidence-segment-v2.ts";
import type { EvidenceTimingV1 } from "./evidence-timing-v1.ts";
import {
  type ReviewEvidence,
  REVIEW_BURST_QUIET_MS,
  reviewFlagsFromEvidence,
  SERVER_PLACEHOLDER_THRESHOLDS,
} from "./review-signals.ts";

type Change = { source: string; from: number; to?: number; text: string; offsetMs: number };

const HASH = "0".repeat(64);
let sequence = 0;

/** One segment starting at `minute` with one event per change. */
function segmentOf(minute: string, changes: Change[], timed = true): ReviewEvidence {
  const first = sequence + 1;
  const events = changes.map((c) => ({
    sequence: ++sequence,
    source: c.source,
    steps: [
      {
        stepType: "replace",
        from: c.from,
        to: c.to ?? c.from,
        ...(c.text ? { slice: { content: [{ type: "text", text: c.text }] } } : {}),
      },
    ],
    beforeDocumentHash: HASH,
    afterDocumentHash: HASH,
  }));
  const segment = {
    evidenceSchema: "ductus-evidence-segment-v2",
    sequenceFrom: first,
    sequenceTo: sequence,
    observedStartedAt: minute,
    observedEndedAt: minute,
    events,
  } as unknown as EvidenceSegment;
  const timing: EvidenceTimingV1 = {
    timingFormat: "ductus-evidence-timing-v1",
    segmentHash: HASH,
    events: changes.map((c, i) => ({ sequence: first + i, stepOffsetsMs: [c.offsetMs] })),
  };
  return { segment, timing: timed ? timing : null };
}

const minute = (m: number) =>
  new Date(Date.UTC(2026, 10, 21, 9, m)).toISOString().replace(".000Z", "Z");

/**
 * `count` characters typed at the end, one per event, `stepMs` apart, split
 * into segments of 30 s like the client, starting at position `at`.
 */
function typing(
  count: number,
  stepMs: number,
  options: { source?: string; at?: number; pauseEvery?: number; pauseMs?: number } = {},
) {
  const out: ReviewEvidence[] = [];
  let t = 0;
  let pos = options.at ?? 1;
  let batch: Change[] = [];
  let batchMinute = 0;
  for (let i = 0; i < count; i++) {
    if (options.pauseEvery && i > 0 && i % options.pauseEvery === 0) t += options.pauseMs ?? 0;
    const m = Math.floor(t / 60_000);
    if (batch.length && (m !== batchMinute || batch.length >= 250)) {
      out.push(segmentOf(minute(batchMinute), batch));
      batch = [];
    }
    batchMinute = m;
    batch.push({
      source: options.source ?? "editor",
      from: pos,
      text: "a",
      offsetMs: t - m * 60_000,
    });
    pos += 1;
    t += stepMs;
  }
  if (batch.length) out.push(segmentOf(minute(batchMinute), batch));
  return out;
}

const rules = (evidence: ReviewEvidence[], rhythmRecorded = true) =>
  reviewFlagsFromEvidence(evidence, { rhythmRecorded }).flags.map((f) => f.rule);

describe("reviewFlagsFromEvidence (P-2 proposal)", () => {
  it("flags R-2 and R-3 on 450 characters typed straight at 100 ms", () => {
    expect(rules(typing(450, 100))).toEqual(["R-2", "R-3"]);
  });

  it("names the stretch of the record by sequence", () => {
    sequence = 0;
    const [flag] = reviewFlagsFromEvidence(typing(450, 100), { rhythmRecorded: true }).flags;
    expect(flag).toMatchObject({ sequenceFrom: 1, sequenceTo: 450 });
  });

  it("gives no flag below the length threshold", () => {
    expect(rules(typing(SERVER_PLACEHOLDER_THRESHOLDS.r2MinChars - 1, 100))).toEqual([]);
  });

  it("drops R-2 when the writer pauses longer than 2 s, keeps R-3", () => {
    expect(rules(typing(450, 100, { pauseEvery: 80, pauseMs: 2500 }))).toEqual(["R-3"]);
  });

  it("splits bursts on quiet longer than 4 s, so neither half is long enough", () => {
    const evidence = typing(450, 100, { pauseEvery: 225, pauseMs: REVIEW_BURST_QUIET_MS + 1000 });
    const result = reviewFlagsFromEvidence(evidence, { rhythmRecorded: true });
    expect(result.bursts.map((b) => b.chars)).toEqual([225, 225]);
    expect(result.flags).toEqual([]);
  });

  it("drops R-3 when the writer goes back into earlier text", () => {
    const evidence = typing(450, 100);
    // An insertion near the start, inside the burst, at the next free offset.
    const last = evidence.at(-1)!;
    const lastOffset = last.timing!.events.at(-1)!.stepOffsetsMs[0]!;
    evidence.push(
      segmentOf(last.segment.observedStartedAt, [
        { source: "editor", from: 5, text: "b", offsetMs: lastOffset + 300 },
      ]),
    );
    expect(rules(evidence)).toEqual(["R-2"]);
  });

  it("treats a correction inside the last word as typing, not going back", () => {
    const evidence = typing(450, 100);
    const last = evidence.at(-1)!;
    const lastOffset = last.timing!.events.at(-1)!.stepOffsetsMs[0]!;
    // Backspace of the last character: from = end - 1.
    evidence.push(
      segmentOf(last.segment.observedStartedAt, [
        { source: "editor", from: 450, to: 451, text: "", offsetMs: lastOffset + 200 },
      ]),
    );
    expect(rules(evidence)).toEqual(["R-2", "R-3"]);
  });

  it.each(["keyless-input", "paste", "composition", "unattributed"])(
    "never puts %s into the rhythm (P-2 §4: assistive input is no reason)",
    (source) => {
      expect(rules(typing(450, 100, { source }))).toEqual([]);
    },
  );

  it("does not compute R-2 when the teacher switched the rhythm off", () => {
    expect(rules(typing(450, 100), false)).toEqual(["R-3"]);
  });

  it("leaves typed events of segments without timing out of every burst and counts them", () => {
    const evidence = typing(450, 100).map((e) => ({ ...e, timing: null }));
    const result = reviewFlagsFromEvidence(evidence, { rhythmRecorded: true });
    expect(result.flags).toEqual([]);
    expect(result.untimedTypingEvents).toBe(450);
  });

  it("treats a timing of another shape as no timing", () => {
    const evidence = typing(450, 100).map((e) => ({
      ...e,
      timing: { ...e.timing!, events: e.timing!.events.slice(1) },
    }));
    expect(reviewFlagsFromEvidence(evidence, { rhythmRecorded: true }).untimedTypingEvents).toBe(
      450,
    );
  });

  it("closes the burst at an untimed segment, so typing on both sides is not joined", () => {
    // 600 characters: segments of 250, 250 and 100 events.
    const evidence = typing(600, 100);
    expect(evidence).toHaveLength(3);
    evidence[1] = { ...evidence[1]!, timing: null };
    const result = reviewFlagsFromEvidence(evidence, { rhythmRecorded: true });
    expect(result.bursts.map((b) => b.chars)).toEqual([250, 100]);
    expect(result.untimedTypingEvents).toBe(250);
    expect(result.flags).toEqual([]);
  });

  it("flags evidence the client sent with no flag of its own: the result depends only on the record", () => {
    // The segment format has no field for a client flag (redteam-integrity.test.ts:
    // an extra field is refused), so a driven browser cannot claim "no flag".
    const evidence = typing(450, 100);
    expect(Object.keys(evidence[0]!.segment)).not.toContain("reviewFlags");
    expect(rules(evidence)).toContain("R-3");
  });
});
