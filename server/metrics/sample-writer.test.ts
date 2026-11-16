// S-1K.4-b part 2 (DAN-834-2): the metric_sample writer as the collector's
// write port, on a fake clock and a fake store. The real logs database is
// tests/db/metric-sample-writer.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetricsCollector } from "./collector.ts";
import {
  createMetricSampleWriter,
  METRIC_SAMPLE_INSERT,
  METRICS_WRITE_DEADLINE_MS,
  type MetricSample,
  type MetricSampleStore,
} from "./sample-writer.ts";

const I = 5_000;
const D = METRICS_WRITE_DEADLINE_MS;
const SAMPLES: readonly MetricSample[] = [{ metric: "request_count", value: 3 }];

const unhandled = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  process.on("unhandledRejection", unhandled);
});
afterEach(() => {
  process.off("unhandledRejection", unhandled);
  unhandled.mockClear();
  vi.useRealTimers();
});

function collectorOver(query: MetricSampleStore["query"]) {
  const store = { query: vi.fn(query) };
  const collect = vi.fn(() => SAMPLES);
  const onSkip = vi.fn();
  const write = createMetricSampleWriter({ store });
  const collector = createMetricsCollector({ intervalMs: I, collect, write, onSkip });
  collector.start();
  return { store, collect, onSkip, collector };
}

describe("createMetricSampleWriter input", () => {
  it.each([0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, "1000", null])(
    "refuses deadlineMs %s",
    (deadlineMs) => {
      const store = { query: vi.fn() };
      expect(() => createMetricSampleWriter({ store, deadlineMs: deadlineMs as number })).toThrow(
        RangeError,
      );
    },
  );

  it.each([undefined, null, {}, { query: "x" }])("refuses the store %s", (store) => {
    expect(() => createMetricSampleWriter({ store: store as never })).toThrow(RangeError);
  });

  it.each([1, 2 ** 31 - 1])("accepts the bound deadlineMs %s", (deadlineMs) => {
    expect(() => createMetricSampleWriter({ store: { query: vi.fn() }, deadlineMs })).not.toThrow();
  });
});

describe("a failing logs database skips the sample and the collector lives on", () => {
  it.each([
    [
      "throws",
      () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:5432");
      },
    ],
    ["rejects", () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3:5432"))],
  ])("store that %s: write_failed, then the next interval writes again", async (_, query) => {
    const { store, collect, onSkip, collector } = collectorOver(query);
    await vi.advanceTimersByTimeAsync(I);
    expect(onSkip.mock.calls).toEqual([["write_failed"]]);
    await vi.advanceTimersByTimeAsync(I);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(store.query).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["write_failed"], ["write_failed"]]);
    await collector.stop();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a hanging store fails at the deadline, holds one query at most, and writes again once it settles", async () => {
    let settle!: (value: unknown) => void;
    const { store, onSkip, collector } = collectorOver(
      () => new Promise((resolve) => (settle = resolve)),
    );
    await vi.advanceTimersByTimeAsync(I + D - 1);
    expect(onSkip).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSkip.mock.calls).toEqual([["write_failed"]]);
    // The query still hangs: the next rounds are skipped without a new query.
    await vi.advanceTimersByTimeAsync(2 * I);
    expect(store.query).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["write_failed"], ["write_failed"], ["write_failed"]]);
    settle(undefined);
    store.query.mockImplementation(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(I);
    expect(store.query).toHaveBeenCalledTimes(2);
    expect(onSkip).toHaveBeenCalledTimes(3);
    await collector.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a hanging query that later rejects frees the place and reaches nobody", async () => {
    let fail!: (error: Error) => void;
    const { store, onSkip, collector } = collectorOver(
      () => new Promise((_, reject) => (fail = reject)),
    );
    await vi.advanceTimersByTimeAsync(I + D);
    fail(new Error("terminating connection 10.1.2.3"));
    store.query.mockImplementation(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(I);
    expect(store.query).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["write_failed"]]);
    await collector.stop();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("refuses with a fixed error that carries no database text", async () => {
    const write = createMetricSampleWriter({
      store: {
        query: () => Promise.reject(new Error("password authentication failed for 10.1.2.3")),
      },
    });
    const error = await write(SAMPLES).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify([String(error), (error as Error).cause])).not.toMatch(/10\.1|password/);
  });
});

describe("the query", () => {
  it("sends one fixed statement with the samples as one JSON parameter", async () => {
    const query = vi.fn(() => Promise.resolve());
    const write = createMetricSampleWriter({ store: { query } });
    const samples: MetricSample[] = [
      { metric: "database_connections", value: 2, labels: { database: "logs" } },
      { metric: "error_count", value: 0 },
    ];
    await write(samples);
    expect(query.mock.calls).toEqual([[METRIC_SAMPLE_INSERT, [JSON.stringify(samples)]]]);
  });

  it("clears the deadline timer once the store answers, and the timer never holds the process", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const { store, collector } = collectorOver(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(I);
    const deadline = timeouts.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(deadline.hasRef()).toBe(false);
    expect(store.query).toHaveBeenCalledTimes(1);
    // Only the collector's interval is left.
    expect(vi.getTimerCount()).toBe(1);
    await collector.stop();
  });

  it("sends nothing for no samples", async () => {
    const query = vi.fn();
    await createMetricSampleWriter({ store: { query } })([]);
    expect(query).not.toHaveBeenCalled();
  });
});
