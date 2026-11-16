// S-1K.4-b part 1 (DAN-834-1): the periodic metrics collector on a fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetricsCollector, type MetricsCollectorOptions } from "./collector.ts";

const I = 1_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(overrides: Partial<MetricsCollectorOptions<number>> = {}) {
  let n = 0;
  const collect = vi.fn(() => (n += 1));
  const write = vi.fn((_sample: number): unknown => undefined);
  const onSkip = vi.fn();
  const collector = createMetricsCollector<number>({
    intervalMs: I,
    collect,
    write,
    onSkip,
    ...overrides,
  });
  return { collector, collect, write, onSkip };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("createMetricsCollector input", () => {
  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 31, "1000", undefined, null])(
    "refuses intervalMs %s before any timer",
    (intervalMs) => {
      expect(() =>
        createMetricsCollector({
          intervalMs: intervalMs as number,
          collect: vi.fn(),
          write: vi.fn(),
        }),
      ).toThrow(RangeError);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([undefined, null, {}, "f"])("refuses a collect, write or onSkip that is %s", (bad) => {
    const ok = { intervalMs: I, collect: vi.fn(), write: vi.fn() };
    for (const key of ["collect", "write", "onSkip"] as const) {
      if (key === "onSkip" && bad === undefined) continue;
      expect(() => createMetricsCollector({ ...ok, [key]: bad as never })).toThrow(RangeError);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2 ** 31 - 1])("accepts the bound intervalMs %s", (intervalMs) => {
    expect(() =>
      createMetricsCollector({ intervalMs, collect: vi.fn(), write: vi.fn() }),
    ).not.toThrow();
  });
});

describe("createMetricsCollector interval", () => {
  it("writes the first sample after one interval, then one per interval", async () => {
    const { collector, write } = setup();
    collector.start();
    collector.start();
    await vi.advanceTimersByTimeAsync(I - 1);
    expect(write).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(2 * I);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("reads no wall clock: moving it does not move the schedule", async () => {
    const { collector, write } = setup();
    collector.start();
    vi.setSystemTime(Date.now() + 10 * I);
    await vi.advanceTimersByTimeAsync(I - 1);
    vi.setSystemTime(Date.now() - 100 * I);
    expect(write).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not overlap rounds: a busy round skips the next ones", async () => {
    const hang = deferred();
    const { collector, collect, write, onSkip } = setup();
    write.mockImplementationOnce(() => hang.promise);
    collector.start();
    await vi.advanceTimersByTimeAsync(3 * I + 10);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["busy"], ["busy"]]);
    hang.resolve();
    await vi.advanceTimersByTimeAsync(I - 10);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("keeps no reference on the process and leaves no timer after stop", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const { collector } = setup();
      collector.start();
      expect(spy).toHaveBeenCalledTimes(1);
      const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      await collector.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createMetricsCollector stop", () => {
  it("waits for the round in progress and starts none after it", async () => {
    const hang = deferred();
    const { collector, write } = setup();
    write.mockImplementationOnce(() => hang.promise);
    collector.start();
    await vi.advanceTimersByTimeAsync(I);
    let stopped = false;
    const first = collector.stop().then(() => (stopped = true));
    const second = collector.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    hang.resolve();
    await Promise.all([first, second]);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * I);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("stopped just before the interval fires, no round starts", async () => {
    const { collector, collect } = setup();
    collector.start();
    await vi.advanceTimersByTimeAsync(I - 1);
    await collector.stop();
    await vi.advanceTimersByTimeAsync(10 * I);
    expect(collect).not.toHaveBeenCalled();
  });

  it("is final: stop before start and start after stop run nothing", async () => {
    const { collector, collect } = setup();
    await expect(collector.stop()).resolves.toBeUndefined();
    collector.start();
    await vi.advanceTimersByTimeAsync(10 * I);
    expect(collect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createMetricsCollector errors", () => {
  const boom = (): never => {
    throw new Error("secret-message.invalid");
  };
  const rejects = () => Promise.reject(new Error("secret-message.invalid"));

  it.each([
    ["collect", "throws", "collect", boom, "collect_failed"],
    ["collect", "rejects", "collect", rejects, "collect_failed"],
    ["write", "throws", "write", boom, "write_failed"],
    ["write", "rejects", "write", rejects, "write_failed"],
  ] as const)("%s that %s skips the round with a code only", async (_n, _k, key, fails, code) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { collector, collect, write, onSkip } = setup();
      (key === "collect" ? collect : write).mockImplementationOnce(fails);
      collector.start();
      await vi.advanceTimersByTimeAsync(I);
      expect(onSkip.mock.calls).toEqual([[code]]);
      await vi.advanceTimersByTimeAsync(I);
      expect(write).toHaveBeenLastCalledWith(key === "collect" ? 1 : 2);
      expect(onSkip).toHaveBeenCalledTimes(1);
      await collector.stop();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each([
    ["throws", boom],
    ["rejects", rejects],
  ])("an onSkip that %s never escapes", async (_k, onSkip) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { collector, write } = setup({ collect: boom, onSkip });
      collector.start();
      await vi.advanceTimersByTimeAsync(3 * I);
      await collector.stop();
      expect(write).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
