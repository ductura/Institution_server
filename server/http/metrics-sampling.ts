// The metrics sampling of the server process (S-1K.4-b part 5a, DAN-834-5a;
// contract Ductus#1836 c.6932720649). http is the one assembler, so the entry
// point (which may import only http, settings and config) gets the collector
// from here: the database connection source over the registry's health, the
// metric_sample writer over the logs database, a skipped round logged by its
// reason only, and the shutdown hook that stops it before the databases close.
import { logEvent, type LogEvent } from "../log/index.ts";
import {
  createConnectionSource,
  createMetricSampleWriter,
  createMetricsCollector,
  type MetricSampleStore,
} from "../metrics/index.ts";
import { FLUSH_LOGS, type ShutdownHook } from "./shutdown.ts";

export type MetricsSamplingOptions = {
  /** From metricsIntervalMs (server/settings), after its problems were checked. */
  readonly intervalMs: number;
  readonly health: () => unknown;
  readonly store: MetricSampleStore;
  readonly log?: LogEvent;
};

export type MetricsSampling = {
  readonly start: () => void;
  /** Stops the collector and waits for the round in progress (1 s write deadline). */
  readonly hook: ShutdownHook;
};

export function createMetricsSampling(options: MetricsSamplingOptions): MetricsSampling {
  const log = options.log ?? logEvent;
  const collector = createMetricsCollector({
    intervalMs: options.intervalMs,
    collect: createConnectionSource(options.health),
    write: createMetricSampleWriter({ store: options.store }),
    onSkip: (reason) => log("warn", "metrics.round_skipped", { reason }),
  });
  return Object.freeze({
    start: collector.start,
    hook: Object.freeze({ name: "metrics", run: collector.stop }),
  });
}

/** The hooks of the server's shutdown, in order: metrics, logs, then the databases. */
export function serverShutdownHooks(parts: {
  readonly metrics: { readonly hook: ShutdownHook };
  readonly databases: { close(): Promise<void> };
}): readonly ShutdownHook[] {
  const { metrics, databases } = parts;
  return [metrics.hook, FLUSH_LOGS, { name: "databases", run: () => databases.close() }];
}
