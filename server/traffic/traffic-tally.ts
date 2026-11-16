// The traffic tally (S-1K.4-b part 3, DAN-834-3; contract Ductus#1836): the
// source of request_count, error_count and latency_p95_ms for the metrics
// collector. It observes the traffic.request records the traffic recorder
// writes and reads only their event, status and duration, as own data
// properties, so an IP, a request id, a route or any other field never
// reaches a sample. It imports nothing; the assembler hands it the records.
import { MAX_DURATION_MS } from "./traffic-record.ts";

/** The metrics this source gives; a part of metric_sample's closed list. */
export type TrafficMetric = "request_count" | "error_count" | "latency_p95_ms";

/** One sample, a row of metric_sample without labels. */
export type TrafficSample = { readonly metric: TrafficMetric; readonly value: number };

export type TrafficTally = {
  /** Counts one traffic.request record; anything else is skipped. Never throws. */
  readonly observe: (input: unknown) => void;
  /** The three samples of the window since the last take, which it empties. */
  readonly take: () => readonly TrafficSample[];
};

/** Upper bounds of the duration buckets in ms; p95 is the bound of its bucket. */
export const LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  MAX_DURATION_MS,
]);

/** An own data property's value; a getter, an inherited key or a trap gives undefined. */
function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

const isWhole = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export function createTrafficTally(): TrafficTally {
  let requests = 0;
  let errors = 0;
  let buckets = LATENCY_BUCKETS_MS.map(() => 0);

  const sample = (metric: TrafficMetric, value: number): TrafficSample =>
    Object.freeze({ metric, value });

  return Object.freeze({
    observe(input: unknown): void {
      try {
        if (ownValue(input, "event") !== "traffic.request") return;
        const fields = ownValue(input, "fields");
        const status = ownValue(fields, "status");
        const durationMs = ownValue(fields, "durationMs");
        if (!isWhole(status, 100, 599) || !isWhole(durationMs, 0, MAX_DURATION_MS)) return;
        requests += 1;
        if (status >= 500) errors += 1;
        buckets[LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound)]! += 1;
      } catch {
        // A record that cannot be read is not counted; the request is untouched.
      }
    },
    take(): readonly TrafficSample[] {
      // Rank ceil(0.95 n), in whole numbers.
      const rank = Math.floor((95 * requests + 99) / 100);
      let seen = 0;
      const index = buckets.findIndex((count) => (seen += count) >= rank);
      const p95 = requests === 0 ? 0 : LATENCY_BUCKETS_MS[index]!;
      const samples = Object.freeze([
        sample("request_count", requests),
        sample("error_count", errors),
        sample("latency_p95_ms", p95),
      ]);
      requests = 0;
      errors = 0;
      buckets = LATENCY_BUCKETS_MS.map(() => 0);
      return samples;
    },
  });
}
