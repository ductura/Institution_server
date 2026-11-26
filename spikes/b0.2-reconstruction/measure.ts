// B0.2 (M3.4): time, memory and checkpoint volume of reconstructing a work of
// 15,000 and 80,000 words with the server's own reconstruction code
// (server/evidence/reconstruction). The record is invented: one paragraph that
// grows by a few invented words per segment. Nothing here touches a database,
// a network or a real work.
import { performance } from "node:perf_hooks";

import {
  buildReconstructionCheckpoints,
  readDocumentAtRevision,
} from "../../server/evidence/reconstruction/index.ts";
import { buildRecord, canonical, EMPTY, replayer, type InventedRecord } from "./record.ts";

export const PILOT_WORDS = 15_000;
export const DOCTORAL_WORDS = 80_000;

export type Scenario = {
  words: number;
  wordsPerSegment: number;
  /** Distance between checkpoints, in segments. */
  checkpointEvery: number;
};

export type Measurement = {
  scenario: Scenario;
  segments: number;
  documentBytes: number;
  fullReplayMs: number;
  checkpointBuildMs: number;
  checkpointCount: number;
  /** Sum of the canonical documents stored as checkpoints. */
  checkpointVolumeBytes: number;
  /** Replay from the last checkpoint before the end of the record. */
  resumedReplayMs: number;
  resumedSegments: number;
  /** Largest heap size seen at the boundaries between stages; not a true peak. */
  heapStageMaxBytes: number;
};

/** `Izmisljena rijec n ` repeated: invented words only. */
export function inventedWords(count: number, wordsPerSegment: number): string[] {
  const texts: string[] = [];
  let word = 0;
  while (word < count) {
    const take = Math.min(wordsPerSegment, count - word);
    texts.push(Array.from({ length: take }, () => `rijec${++word}`).join(" ") + " ");
  }
  return texts;
}

const ms = (since: number): number => Math.round((performance.now() - since) * 100) / 100;

export async function measure(scenario: Scenario, record?: InventedRecord): Promise<Measurement> {
  const built =
    record ?? (await buildRecord(inventedWords(scenario.words, scenario.wordsPerSegment)));
  const { segments } = built;
  const initialDocument = canonical(EMPTY);
  const last = segments.length;
  let heapPeak = process.memoryUsage().heapUsed;
  const sample = () => (heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed));

  let started = performance.now();
  const full = await readDocumentAtRevision({
    initialDocument,
    segments,
    revision: last,
    replayer,
    checkpoint: null,
  });
  const fullReplayMs = ms(started);
  sample();
  if (!full.ok) throw new Error(`full replay failed: ${full.reason}`);

  const revisions: number[] = [];
  for (let at = scenario.checkpointEvery; at <= last; at += scenario.checkpointEvery) {
    revisions.push(at);
  }
  started = performance.now();
  const built2 = await buildReconstructionCheckpoints({
    initialDocument,
    segments,
    revisions,
    replayer,
  });
  const checkpointBuildMs = ms(started);
  sample();
  if (!built2.ok) throw new Error(`checkpoint build failed: ${built2.reason}`);
  const checkpoints = built2.checkpoints;
  const volume = checkpoints.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0);

  const before = checkpoints.filter((item) => item.revision < last).at(-1) ?? null;
  started = performance.now();
  const resumed = await readDocumentAtRevision({
    initialDocument,
    segments,
    revision: last,
    replayer,
    checkpoint: before,
  });
  const resumedReplayMs = ms(started);
  sample();
  if (!resumed.ok || resumed.documentSha256 !== full.documentSha256) {
    throw new Error("resumed replay does not give the full replay's document");
  }
  if (before !== null && (resumed.source !== "checkpoint" || resumed.fallback !== null)) {
    throw new Error(`checkpoint was not used (fallback: ${resumed.fallback ?? "none"})`);
  }

  return {
    scenario,
    segments: last,
    documentBytes: Buffer.byteLength(full.canonicalDocument),
    fullReplayMs,
    checkpointBuildMs,
    checkpointCount: checkpoints.length,
    checkpointVolumeBytes: volume,
    resumedReplayMs,
    resumedSegments: last - resumed.startRevision,
    heapStageMaxBytes: heapPeak,
  };
}
