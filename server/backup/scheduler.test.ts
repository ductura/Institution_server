// S-1G-a part 2 (DAN-1012-2a; contract Ductus#2028 c.6965270952): the backup
// scheduler on a fake clock. Negative cases first: the job never runs unless
// backup.enabled is exactly true.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_CHECK_MS as H,
  BACKUP_SKIP_REASONS,
  createBackupScheduler,
  type BackupSchedulerOptions,
} from "./scheduler.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const CANARY = "secret-message.invalid";

function setup(
  initial: Iterable<[string, unknown]>,
  overrides: Partial<BackupSchedulerOptions> = {},
) {
  const state = { settings: new Map<string, unknown>(initial) as unknown };
  const readSettings = vi.fn((): unknown => state.settings);
  const run = vi.fn((): unknown => undefined);
  const onSkip = vi.fn();
  const scheduler = createBackupScheduler({ readSettings, run, onSkip, ...overrides });
  scheduler.start();
  return { state, readSettings, run, onSkip, scheduler };
}

const on = (interval?: unknown): [string, unknown][] =>
  interval === undefined
    ? [["backup.enabled", true]]
    : [
        ["backup.enabled", true],
        ["backup.interval_hours", interval],
      ];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("backup scheduler: backup.enabled that is not exactly true never runs", () => {
  const notTrue: [string, [string, unknown][], string][] = [
    ["missing", [["backup.interval_hours", 1]], "enabled_missing"],
    ["false", [["backup.enabled", false]], "disabled"],
    ...["true", "true\r\n", "\ttrue", "\u00a0true", "true\u007f", 1, 0, null, NaN, [true]].map(
      (value): [string, [string, unknown][], string] => [
        JSON.stringify(value) ?? String(value),
        [
          ["backup.enabled", value],
          ["backup.interval_hours", 1],
        ],
        "enabled_invalid",
      ],
    ),
    ["{}", [["backup.enabled", {}]], "enabled_invalid"],
    ["undefined (present)", [["backup.enabled", undefined]], "enabled_invalid"],
    [
      "valueOf/toString true",
      [["backup.enabled", { valueOf: () => true, toString: () => "true" }]],
      "enabled_invalid",
    ],
  ];

  it.each(notTrue)(
    "enabled %s: no run over three days, a reason every hour",
    async (_n, rows, reason) => {
      const { run, onSkip } = setup(rows);
      await vi.advanceTimersByTimeAsync(72 * H);
      expect(run).not.toHaveBeenCalled();
      expect(onSkip.mock.calls).toEqual(Array.from({ length: 72 }, () => [reason]));
    },
  );

  class LyingMap extends Map<string, unknown> {
    override get(): unknown {
      return true;
    }
    override has(): boolean {
      return true;
    }
  }
  const unavailable: [string, () => unknown][] = [
    ["a plain object", () => ({ "backup.enabled": true, "backup.interval_hours": 1 })],
    ["an inheriting object", () => Object.create({ "backup.enabled": true }) as unknown],
    ["undefined", () => undefined],
    ["a bare Map prototype", () => Object.create(Map.prototype) as unknown],
    ["a Proxy of a Map", () => new Proxy(new Map(on(1)), {})],
    [
      "a throw",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["a rejection", () => Promise.reject(new Error(CANARY))],
  ];

  it.each(unavailable)("a reader giving %s: settings_unavailable, no run", async (_n, read) => {
    const { run, onSkip } = setup([], { readSettings: read });
    await vi.advanceTimersByTimeAsync(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(onSkip.mock.calls).toEqual(Array.from({ length: 48 }, () => ["settings_unavailable"]));
  });

  it("reads a Map subclass through Map.prototype, not its own get and has", async () => {
    const { state, run, onSkip } = setup([]);
    state.settings = new LyingMap([["backup.enabled", false]]);
    await vi.advanceTimersByTimeAsync(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(new Set(onSkip.mock.calls.flat())).toEqual(new Set(["disabled"]));
    // No interval key: the default 24 h, not the subclass's word that one is there.
    state.settings = new LyingMap([["backup.enabled", true]]);
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([0, 25, 1.5, -0, "24", NaN, Infinity, true, null])(
    "enabled with interval_hours %s: interval_invalid, no run",
    async (interval) => {
      const { run, onSkip } = setup(on(interval));
      await vi.advanceTimersByTimeAsync(48 * H);
      expect(run).not.toHaveBeenCalled();
      expect(new Set(onSkip.mock.calls.flat())).toEqual(new Set(["interval_invalid"]));
    },
  );
});

describe("backup scheduler: enabled runs once per interval", () => {
  it.each([
    [1, 1],
    [5, 5],
    [24, 24],
    [undefined, 24],
  ])("interval_hours %s runs at every %s h boundary, three times", async (interval, hours) => {
    const { run, onSkip } = setup(on(interval));
    await vi.advanceTimersByTimeAsync(hours * H - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * hours * H - 1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    ["false", [["backup.enabled", false]]],
    ["invalid", [["backup.enabled", "true"]]],
  ] as [string, [string, unknown][]][])(
    "turned on after 100 h %s, runs only after a full interval",
    async (_n, off) => {
      const { state, run } = setup(off);
      await vi.advanceTimersByTimeAsync(100 * H);
      state.settings = new Map(on(6));
      await vi.advanceTimersByTimeAsync(6 * H - 1);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("an invalid interval keeps counting: the run comes as soon as it is valid", async () => {
    const { state, run } = setup(on(0));
    await vi.advanceTimersByTimeAsync(10 * H);
    state.settings = new Map(on(2));
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // DAN-1012-2a (option A, Ductus#2028 c.6965242237): run() is called on a
  // fixed hourly grid from start(); the job's own timing never moves it.
  const callTimes = (run: { mockImplementation: (fn: () => unknown) => unknown }) => {
    const calls: number[] = [];
    const t0 = performance.now();
    return {
      calls,
      record: (fn: () => unknown = () => undefined) =>
        run.mockImplementation(() => {
          calls.push((performance.now() - t0) / H);
          return fn();
        }),
    };
  };

  it.each([1, 5, 24])("interval %s: every call is on the grid", async (interval) => {
    const { run } = setup(on(interval));
    const { calls, record } = callTimes(run);
    record();
    await vi.advanceTimersByTimeAsync(3 * interval * H);
    expect(calls).toEqual([interval, 2 * interval, 3 * interval]);
  });

  // QA FAIL 2 on #283 (30a28bf): a job that takes 5 min does not move the next call.
  it.each([1, 2])(
    "a synchronous 5 min job: interval %s, the next call stays on the grid",
    async (interval) => {
      const { run } = setup(on(interval));
      const { calls, record } = callTimes(run);
      record(() => vi.advanceTimersByTime(5 * 60_000));
      await vi.advanceTimersByTimeAsync(3 * interval * H);
      expect(calls).toEqual([interval, 2 * interval, 3 * interval]);
    },
  );

  // Review and QA FAIL 1 on #283 (30a28bf): the job's own preparation is its own.
  it("an asynchronous 5 min preparation: calls stay on the grid", async () => {
    const { run } = setup(on(1));
    const { calls, record } = callTimes(run);
    record(() => new Promise((resolve) => setTimeout(resolve, 5 * 60_000)));
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("a read under an hour delays only its own call, not the grid", async () => {
    const { readSettings, run } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 0.75 * H)),
    );
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(calls).toEqual([1.75, 2, 3]);
  });

  it("a read past the next tick calls nothing: no call leaves its own hour", async () => {
    const { readSettings, run, onSkip } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 1.5 * H)),
    );
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(calls).toEqual([3]);
    expect(onSkip.mock.calls).toEqual([["busy"], ["settings_unavailable"]]);
  });

  it("a slow read that sees backup off: the hours count from that tick", async () => {
    const { state, readSettings, run } = setup([["backup.enabled", false]]);
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Map([["backup.enabled", false]])), 0.75 * H),
        ),
    );
    await vi.advanceTimersByTimeAsync(1.75 * H);
    state.settings = new Map(on(2));
    await vi.advanceTimersByTimeAsync(2.25 * H);
    expect(calls).toEqual([3]);
  });

  it("a run that throws synchronously is run_failed and still resets the hours", async () => {
    const { run, onSkip } = setup(on(2));
    run.mockImplementationOnce(() => {
      throw new Error(CANARY);
    });
    await vi.advanceTimersByTimeAsync(4 * H - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["run_failed"]]);
  });

  it("turned off, no run from the next hour", async () => {
    const { state, run } = setup(on(1));
    await vi.advanceTimersByTimeAsync(3 * H);
    state.settings = new Map([["backup.enabled", false]]);
    await vi.advanceTimersByTimeAsync(48 * H);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("a changed interval counts from the last run", async () => {
    const { state, run } = setup(on(24));
    await vi.advanceTimersByTimeAsync(10 * H);
    state.settings = new Map(on(6));
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(1);
    state.settings = new Map(on(24));
    await vi.advanceTimersByTimeAsync(24 * H - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("unavailable then available again: one run, no catching up", async () => {
    const { state, run } = setup(on(2));
    state.settings = undefined;
    await vi.advanceTimersByTimeAsync(10 * H);
    state.settings = new Map(on(2));
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a run longer than an hour is busy: the busy hour reads nothing, no second run", async () => {
    const hang = deferred();
    const { readSettings, run, onSkip } = setup(on(1));
    run.mockImplementationOnce(() => hang.promise);
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(run).toHaveBeenCalledTimes(1);
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["busy"], ["busy"]]);
    hang.resolve();
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("busy hours count toward the next interval", async () => {
    const hang = deferred();
    const { run } = setup(on(3));
    run.mockImplementationOnce(() => hang.promise);
    await vi.advanceTimersByTimeAsync(5 * H);
    hang.resolve();
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reads no wall clock", async () => {
    const { run } = setup(on(2));
    vi.setSystemTime(Date.now() + 100 * H);
    await vi.advanceTimersByTimeAsync(H);
    vi.setSystemTime(Date.now() - 1000 * H);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(H);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("backup scheduler: failures, stop and options", () => {
  it.each([
    [
      "throws",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["rejects", () => Promise.reject(new Error(CANARY))],
  ])("a run that %s is run_failed and retried next interval", async (_k, fails) => {
    const { run, onSkip } = setup(on(2));
    run.mockImplementationOnce(fails);
    await vi.advanceTimersByTimeAsync(4 * H);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["run_failed"]]);
  });

  it("an onSkip that throws or rejects never stops the scheduler", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let n = 0;
      const onSkip = () => {
        n += 1;
        if (n % 2 === 1) return Promise.reject(new Error(CANARY));
        throw new Error(CANARY);
      };
      const { state, run, scheduler } = setup([["backup.enabled", false]], { onSkip });
      await vi.advanceTimersByTimeAsync(5 * H);
      state.settings = new Map(on(1));
      await vi.advanceTimersByTimeAsync(H);
      expect(run).toHaveBeenCalledTimes(1);
      await scheduler.stop();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("every reason is from the closed list, never a message", () => {
    expect([...BACKUP_SKIP_REASONS].sort()).toEqual([
      "busy",
      "disabled",
      "enabled_invalid",
      "enabled_missing",
      "interval_invalid",
      "run_failed",
      "settings_unavailable",
    ]);
  });

  // Review FAIL on #283 (46443d6): stop() called synchronously from inside run().
  it.each([
    ["resolves", (done: Promise<void>) => done],
    ["rejects", (done: Promise<void>) => done.then(() => Promise.reject(new Error(CANARY)))],
  ])("a run that calls stop and then %s: stop waits for it", async (_k, finish) => {
    const hang = deferred();
    let stopping: Promise<void> | undefined;
    const options = { run: (): unknown => undefined };
    let calls = 0;
    const { scheduler } = setup(on(1), { run: () => options.run() });
    options.run = () => {
      calls += 1;
      stopping = scheduler.stop();
      return finish(hang.promise);
    };
    let stopped = false;
    await vi.advanceTimersByTimeAsync(H);
    expect(stopping).toBeDefined();
    void stopping?.then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    hang.resolve();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * H);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
  });

  it("stop waits for the run in progress and leaves no timer", async () => {
    const hang = deferred();
    const { run, scheduler } = setup(on(1));
    run.mockImplementationOnce(() => hang.promise);
    await vi.advanceTimersByTimeAsync(H);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    hang.resolve();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an interval key present with the value undefined is interval_invalid", async () => {
    const { run, onSkip } = setup([
      ["backup.enabled", true],
      ["backup.interval_hours", undefined],
    ]);
    await vi.advanceTimersByTimeAsync(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(new Set(onSkip.mock.calls.flat())).toEqual(new Set(["interval_invalid"]));
  });

  it("stop does not wait for a settings read that never ends", async () => {
    const { scheduler, onSkip } = setup(on(1), {
      readSettings: () => new Promise(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(onSkip.mock.calls).toEqual([["busy"], ["busy"]]);
    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a read that ends after stop starts no run", async () => {
    const read = deferred();
    const { run, scheduler } = setup(on(1), {
      readSettings: () => read.promise.then(() => new Map(on(1))),
    });
    await vi.advanceTimersByTimeAsync(H);
    const stopping = scheduler.stop();
    read.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * H);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one fixed timer, never a reference on the process", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const { state } = setup(on(1));
      await vi.advanceTimersByTimeAsync(3 * H);
      state.settings = new Map([["backup.enabled", false]]);
      await vi.advanceTimersByTimeAsync(3 * H);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([undefined, null, {}, "f"])("refuses a readSettings, run or onSkip that is %s", (bad) => {
    for (const key of ["readSettings", "run", "onSkip"] as const) {
      const options = { readSettings: vi.fn(), run: vi.fn(), onSkip: vi.fn(), [key]: bad };
      expect(() => createBackupScheduler(options as unknown as BackupSchedulerOptions)).toThrow(
        RangeError,
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
