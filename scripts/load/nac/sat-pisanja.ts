// NAC-F1-SRV: the "hour of writing" scenario. One synthetic student writes for
// an hour: a short document, a rest, a long document, a teacher watching the
// live view, a lost connection and its return. This module is the dry run: it
// replays that hour second by second against the client rhythm and builds the
// REAL save chain (lanac.ts), so every byte of a save body is measured, but it
// sends nothing and needs no stack. Server-side figures (query time, locks,
// CPU, signature latency) need the local stack and are not produced here.

import { buildCommitChain, type CommitBody, type OpenedWork } from "../index.ts";

/** Client rhythm, from the WEB repo (branch migracija/kopija-ductus-front). */
export const RHYTHM = {
  /** src/client/live-publisher.ts:34 LIVE_PUBLISH_GAP_MS: at most one PUT a second. */
  livePublishGapMs: 1000,
  /** live-publisher.ts:35-36 LIVE_PUBLISH_RETRY_FIRST_MS / _MAX_MS. */
  livePublishRetryFirstMs: 2000,
  livePublishRetryMaxMs: 30_000,
  /** src/client/live-reader.ts:53 LIVE_READ_INTERVAL_MS: the teacher's view reads every second. */
  liveReadIntervalMs: 1000,
  /** live-reader.ts:54-55 LIVE_RETRY_FIRST_MS / _MAX_MS. */
  liveRetryFirstMs: 2000,
  liveRetryMaxMs: 30_000,
} as const;

/**
 * ASSUMPTION (not found in the WEB code): no constant for the save cadence
 * exists in src/client or packages/editor-core/src/{sync,journal}. The saves
 * follow the existing `nastava` pacing of scripts/load/scenarij.ts: one save
 * every 5 to 15 s while the student types. Replace with the NAC-F1-WEB finding.
 */
export const SAVE_GAP_S = [5, 15] as const;
/** ASSUMPTION: characters typed between two saves (a short sentence). */
export const CHARS_PER_SAVE = 40;

export type PhaseKind = "pisanje" | "mirovanje";
export type Phase = {
  name: string;
  kind: PhaseKind;
  /** Length of the phase in seconds. */
  seconds: number;
  /** Characters of the work when the phase starts (a preloaded long document). */
  startChars?: number;
};

/** One hour: 10 min short, 5 rest, 20 long, 5 away, 15 long again, 5 rest. */
export const HOUR: readonly Phase[] = [
  { name: "kratki dokument", kind: "pisanje", seconds: 600 },
  { name: "mirovanje", kind: "mirovanje", seconds: 300 },
  { name: "veći dokument", kind: "pisanje", seconds: 1200, startChars: 60_000 },
  { name: "povratak nakon prekida", kind: "pisanje", seconds: 900 },
  { name: "mirovanje na kraju", kind: "mirovanje", seconds: 600 },
];
/** Seconds (from the hour's start) the teacher has the live view open. */
export const TEACHER_OPEN: readonly [number, number] = [900, 2700];
/** Seconds the connection is lost; saves queue and retries back off. */
export const OUTAGE: readonly [number, number] = [1800, 2100];

export type Counts = {
  saveRequests: number;
  signedReceipts: number;
  livePut: number;
  liveGet200: number;
  liveGet304: number;
  liveFailed: number;
  /** Bytes the client sends: JSON bodies of saves and the JCS bytes of live PUTs. */
  sentBytes: number;
  /** Bytes of live GET 200 bodies. Save and PUT responses are NOT measured in a dry run. */
  receivedBytes: number;
  saves: number;
  maxSaveBodyBytes: number;
  minSaveBodyBytes: number;
};

/** Small deterministic generator (mulberry32), so a run repeats exactly. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sentence = (index: number): string =>
  `Izmišljena rečenica broj ${index} o kućnom kompostiranju. `.padEnd(CHARS_PER_SAVE, "x");

/** The times (s) of every save in the hour, and the phase kind at each second. */
export function saveTimes(seed: number): number[] {
  const random = prng(seed);
  const times: number[] = [];
  let start = 0;
  for (const phase of HOUR) {
    if (phase.kind === "pisanje") {
      let at = start + SAVE_GAP_S[0] + random() * (SAVE_GAP_S[1] - SAVE_GAP_S[0]);
      while (at < start + phase.seconds) {
        times.push(Math.floor(at));
        at += SAVE_GAP_S[0] + random() * (SAVE_GAP_S[1] - SAVE_GAP_S[0]);
      }
    }
    start += phase.seconds;
  }
  return times;
}

const phaseAt = (second: number): Phase | undefined => {
  let start = 0;
  for (const phase of HOUR) {
    if (second < start + phase.seconds) return phase;
    start += phase.seconds;
  }
  return undefined;
};

/** Replays the hour for one user; the chain bodies are real, the rest is counted. */
export function simulateHour(work: OpenedWork, minute: string, seed = 1): Counts {
  const times = saveTimes(seed);
  const total = HOUR.reduce((sum, phase) => sum + phase.seconds, 0);
  // The long document is a first, large text; the saves then append to it.
  const longStart = HOUR.findIndex((phase) => phase.startChars !== undefined);
  const longAt = HOUR.slice(0, longStart).reduce((sum, phase) => sum + phase.seconds, 0);
  const texts = times.map((time, index) =>
    index > 0 && time >= longAt && (times[index - 1] ?? 0) < longAt
      ? "L".repeat(HOUR[longStart]?.startChars ?? 0) + sentence(index)
      : sentence(index),
  );
  const chain: CommitBody[] = buildCommitChain(work, texts, minute, "sat");
  const counts: Counts = {
    saveRequests: 0,
    signedReceipts: 0,
    livePut: 0,
    liveGet200: 0,
    liveGet304: 0,
    liveFailed: 0,
    sentBytes: 0,
    receivedBytes: 0,
    saves: chain.length,
    maxSaveBodyBytes: 0,
    minSaveBodyBytes: Number.POSITIVE_INFINITY,
  };
  const down = (second: number): boolean => second >= OUTAGE[0] && second < OUTAGE[1];
  const bodyBytes = (commit: CommitBody): number => Buffer.byteLength(JSON.stringify(commit));
  const documentBytes = (commit: CommitBody): number =>
    Buffer.from(commit.document, "base64").length;

  let queued: CommitBody[] = [];
  let lastIndex = -1; // index of the last save whose document the live view shows
  let publishedIndex = -1;
  let readIndex = -1;
  let publishRetry = 0;
  let publishNext = 0;
  let readRetry = 0;
  let readNext = 0;
  const saveAt = new Map<number, number>();
  times.forEach((time, index) => saveAt.set(time, index));

  const sendSave = (commit: CommitBody): void => {
    const size = bodyBytes(commit);
    counts.saveRequests += 1;
    counts.signedReceipts += 1;
    counts.sentBytes += size;
    counts.maxSaveBodyBytes = Math.max(counts.maxSaveBodyBytes, size);
    counts.minSaveBodyBytes = Math.min(counts.minSaveBodyBytes, size);
  };

  for (let second = 0; second < total; second += 1) {
    const index = saveAt.get(second);
    const phase = phaseAt(second);
    if (index !== undefined && phase?.kind === "pisanje") {
      const commit = chain[index];
      if (commit !== undefined) {
        lastIndex = index;
        if (down(second)) queued.push(commit);
        else sendSave(commit);
      }
    }
    // The connection is back: the queue drains back to back (the `sinkronizacija` shape).
    if (!down(second) && queued.length > 0) {
      for (const commit of queued) sendSave(commit);
      queued = [];
    }
    // Live publisher: one PUT a second at most while the document changed.
    if (lastIndex > publishedIndex && second >= publishNext) {
      const commit = chain[lastIndex];
      if (commit !== undefined) {
        if (down(second)) {
          counts.liveFailed += 1;
          publishRetry =
            publishRetry === 0
              ? RHYTHM.livePublishRetryFirstMs / 1000
              : Math.min(publishRetry * 2, RHYTHM.livePublishRetryMaxMs / 1000);
          publishNext = second + publishRetry;
        } else {
          counts.livePut += 1;
          counts.sentBytes += documentBytes(commit);
          publishedIndex = lastIndex;
          publishRetry = 0;
          publishNext = second + RHYTHM.livePublishGapMs / 1000;
        }
      }
    }
    // Live reader: every second while the teacher has the view open.
    if (second >= TEACHER_OPEN[0] && second < TEACHER_OPEN[1] && second >= readNext) {
      if (down(second)) {
        counts.liveFailed += 1;
        readRetry =
          readRetry === 0
            ? RHYTHM.liveRetryFirstMs / 1000
            : Math.min(readRetry * 2, RHYTHM.liveRetryMaxMs / 1000);
        readNext = second + readRetry;
      } else {
        readRetry = 0;
        readNext = second + RHYTHM.liveReadIntervalMs / 1000;
        const commit = publishedIndex >= 0 ? chain[publishedIndex] : undefined;
        if (commit !== undefined && publishedIndex > readIndex) {
          counts.liveGet200 += 1;
          counts.receivedBytes += documentBytes(commit);
          readIndex = publishedIndex;
        } else counts.liveGet304 += 1;
      }
    }
  }
  if (!Number.isFinite(counts.minSaveBodyBytes)) counts.minSaveBodyBytes = 0;
  return counts;
}

/** The sentence the findings document quotes, from the counts of one user. */
export function summarize(counts: Counts): string {
  const requests = counts.saveRequests + counts.livePut + counts.liveGet200 + counts.liveGet304;
  const megabytes = (counts.sentBytes + counts.receivedBytes) / (1024 * 1024);
  return `jedan sat ovakvog pisanja stvara ${requests} zahtjeva, ${megabytes.toFixed(1)} MB prometa, ${counts.signedReceipts} potpisa`;
}
