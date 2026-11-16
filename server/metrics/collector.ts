// The periodic metrics collector (S-1K.4-b part 1, DAN-834-1; contract
// Ductus#1836 c.6928940630). Every `intervalMs` one round runs: `collect`,
// then `write` of what it gave. It imports nothing: metrics may import only
// settings (docs/server-map.md §2), so the sources and the writer of
// metric_sample are handed in by the assembler (834-2, 834-3).

/** Why a round was skipped; `onSkip` gets only one of these, never a message. */
export const METRICS_SKIP_REASONS = Object.freeze([
  "busy",
  "collect_failed",
  "write_failed",
] as const);

export type MetricsSkipReason = (typeof METRICS_SKIP_REASONS)[number];

export type MetricsCollectorOptions<T> = {
  /** Time between rounds, a whole number of ms from 1 to 2^31 - 1. */
  readonly intervalMs: number;
  readonly collect: () => T | Promise<T>;
  readonly write: (sample: T) => unknown;
  /** Told of every skipped round; may be async, and never reaches the caller. */
  readonly onSkip?: (reason: MetricsSkipReason) => unknown;
};

export type MetricsCollector = {
  /** Starts the timer; a second call, or a call after stop, does nothing. */
  readonly start: () => void;
  /** Stops for good and waits for the round in progress; never rejects. */
  readonly stop: () => Promise<void>;
};

/** The longest delay setInterval keeps; a longer one Node silently makes 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export function createMetricsCollector<T>(options: MetricsCollectorOptions<T>): MetricsCollector {
  const { intervalMs, collect, write, onSkip } = options;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) {
    throw new RangeError("intervalMs must be a whole number of ms from 1 to 2^31 - 1");
  }
  // Only an absent onSkip is optional; null or any other value is refused.
  const given = onSkip === undefined ? { collect, write } : { collect, write, onSkip };
  for (const [name, fn] of Object.entries(given)) {
    if (typeof fn !== "function") throw new RangeError(`${name} must be a function`);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let round: Promise<void> | undefined;

  const skip = (reason: MetricsSkipReason): void => {
    try {
      void Promise.resolve(onSkip?.(reason)).catch(() => undefined);
    } catch {
      // A failing listener never stops the collector.
    }
  };

  const run = async (): Promise<void> => {
    let sample: T;
    try {
      sample = await collect();
    } catch {
      return skip("collect_failed");
    }
    try {
      await write(sample);
    } catch {
      skip("write_failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    if (round !== undefined) return skip("busy");
    round = run().finally(() => (round = undefined));
  };

  return Object.freeze({
    start(): void {
      if (stopped || timer !== undefined) return;
      timer = setInterval(tick, intervalMs);
      // The collector alone never keeps the process up.
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await round;
    },
  });
}
