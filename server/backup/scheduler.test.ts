// S-1G-a part 2 (DAN-1012-2; contract Ductus#2028 c.6963924920): the backup
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

  // Codex on #283: hours count from the start, not from the check that began it.
  it("a slow read moves the next start: two starts are a full interval apart", async () => {
    const { readSettings, run } = setup(on(1));
    readSettings.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 0.75 * H)),
    );
    await vi.advanceTimersByTimeAsync(1.75 * H);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(H - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
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

  it("a read that ends after stop starts no run", async () => {
    const read = deferred();
    const { run, scheduler } = setup(on(1), {
      readSettings: () => read.promise.then(() => new Map(on(1))),
    });
    await vi.advanceTimersByTimeAsync(H);
    const stopping = scheduler.stop();
    read.resolve();
    await stopping;
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer, never a reference on the process, through every restart", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const { state } = setup(on(1));
      await vi.advanceTimersByTimeAsync(3 * H);
      state.settings = new Map([["backup.enabled", false]]);
      await vi.advanceTimersByTimeAsync(3 * H);
      expect(spy.mock.calls.length).toBeGreaterThan(3);
      for (const result of spy.mock.results) {
        expect((result.value as NodeJS.Timeout).hasRef()).toBe(false);
      }
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
