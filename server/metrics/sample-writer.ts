// The metric_sample writer (S-1K.4-b part 2, DAN-834-2; contract Ductus#1836).
// It is the `write` port of the collector (collector.ts): a refused promise
// makes the collector skip the round with "write_failed", so a failing logs
// database never reaches a caller. It imports nothing (metrics may import only
// settings, docs/server-map.md §2): the store is a pg pool or client the
// assembler makes with a login of ductus_logs_writer (834-3).

/** Metric names of the closed list of metric_sample (DAN-833). */
export type MetricName =
  | "request_count"
  | "error_count"
  | "latency_p95_ms"
  | "active_sessions"
  | "queue_depth"
  | "disk_free_percent"
  | "database_connections";

/**
 * One row of metric_sample. The table's CHECK constraints are the one place
 * the closed lists live; a sample outside them is refused by the database and
 * the whole round is skipped.
 */
export type MetricSample = {
  readonly metric: MetricName;
  /** A count, 0 to 2^53 - 1. */
  readonly value: number;
  readonly labels?: {
    readonly database?: "main" | "logs" | "legal";
    readonly service?: "srce_auth" | "storage" | "keys" | "email";
  };
};

/** The port to the logs database; `query` of a pg Pool or PoolClient fits it. */
export type MetricSampleStore = {
  readonly query: (text: string, values: unknown[]) => unknown;
};

export type MetricSampleWriterOptions = {
  readonly store: MetricSampleStore;
  /** Longest wait for the store, a whole number of ms from 1 to 2^31 - 1. */
  readonly deadlineMs?: number;
};

/** How long one round waits for the logs database, as LOG_WRITE_DEADLINE_MS. */
export const METRICS_WRITE_DEADLINE_MS = 1_000;

/** One statement for the whole round: every sample or none. */
export const METRIC_SAMPLE_INSERT =
  "INSERT INTO public.metric_sample (metric, value, labels) " +
  "SELECT s.metric, s.value, coalesce(s.labels, '{}'::jsonb) " +
  "FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS s(metric text, value bigint, labels jsonb)";

/** The longest delay setTimeout keeps; a longer one Node silently makes 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** The only reason a write is refused with: never the database's message. */
const refused = (): Error => new Error("metric samples not written");

export function createMetricSampleWriter(
  options: MetricSampleWriterOptions,
): (samples: readonly MetricSample[]) => Promise<void> {
  const store = options?.store;
  if (typeof store?.query !== "function") throw new RangeError("store.query must be a function");
  // Only an absent deadline takes the default; null is refused as any other value.
  const deadlineMs =
    options.deadlineMs === undefined ? METRICS_WRITE_DEADLINE_MS : options.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_TIMER_MS) {
    throw new RangeError("deadlineMs must be a whole number of ms from 1 to 2^31 - 1");
  }

  // A query the deadline gave up on still holds the store; while it does, no
  // new query is sent, so a hanging logs database holds one connection at most.
  let pending = false;

  return async (samples) => {
    if (samples.length === 0) return;
    if (pending) throw refused();
    pending = true;
    // A throwing query, or a throwing `then` of its result, rejects `work`.
    const work = Promise.resolve().then(() =>
      store.query(METRIC_SAMPLE_INSERT, [JSON.stringify(samples)]),
    );
    const done = work.then(
      () => true,
      () => false,
    );
    void done.then(() => (pending = false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
      // A hanging logs database never keeps the process up.
      timer.unref?.();
    });
    const written = await Promise.race([done, late]).finally(() => clearTimeout(timer));
    if (!written) throw refused();
  };
}
