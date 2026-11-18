// S-1G-a part 2 (DAN-1012-2c; contracts Ductus#2028 c.6966729858 and c.6967474538): the backup
// scheduler on a fake clock. Negative cases first: the job never runs unless
// backup.enabled is exactly true.
import { types } from "node:util";
import { runInNewContext } from "node:vm";

// Taken before any test fakes timers: a real turn of the event loop, after
// which Node has reported any unhandled rejection.
const realImmediate = setImmediate;
const realTurn = () => new Promise((resolve) => realImmediate(resolve));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_CHECK_MS as H,
  BACKUP_SKIP_REASONS,
  createBackupScheduler,
  type BackupSchedulerOptions,
} from "./scheduler.ts";

// The scheduler hands reasons to onSkip with setImmediate. A fake immediate
// made during a fake tick is due 1 ms later, so advance() steps that 1 ms only
// when one is pending and takes it back from the next advance: the clock stays
// on the grid the tests count on.
let pendingImmediates = 0;
let ahead = 0;
beforeEach(() => {
  vi.useFakeTimers();
  pendingImmediates = 0;
  ahead = 0;
  const fakeSetImmediate = globalThis.setImmediate;
  vi.spyOn(globalThis, "setImmediate").mockImplementation(((fn: () => void) => {
    pendingImmediates += 1;
    return fakeSetImmediate(() => {
      pendingImmediates -= 1;
      fn();
    });
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Advances the fake clock, then lets the reasons it queued reach onSkip. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(Math.max(0, ms - ahead));
  ahead = 0;
  if (pendingImmediates > 0) {
    await vi.advanceTimersByTimeAsync(1);
    ahead = 1;
  }
}

const CANARY = "secret-message.invalid";

function setup(
  initial: Iterable<[string, unknown]>,
  overrides: Partial<BackupSchedulerOptions> = {},
) {
  const state = { settings: new Map<string, unknown>(initial) as unknown };
  const readSettings = vi.fn((): unknown => state.settings);
  const run = vi.fn((): unknown => undefined);
  const onSkip = vi.fn();
  // Hostile result shapes are the attack class (DAN-1012-2e), so the spy may return anything.
  const scheduler = createBackupScheduler({
    readSettings,
    run: run as BackupSchedulerOptions["run"],
    onSkip,
    ...overrides,
  });
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

/** Records the time of each call of run(), in hours from now on the fake clock. */
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
      await advance(72 * H);
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
    await advance(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(onSkip.mock.calls).toEqual(Array.from({ length: 48 }, () => ["settings_unavailable"]));
  });

  // QA FAIL on #289 (7d37ecf): a real Map from another realm is a Map.
  it("accepts a real Map from another VM context", async () => {
    const foreign = runInNewContext(
      'new Map([["backup.enabled", true], ["backup.interval_hours", 1]])',
    ) as unknown;
    expect(foreign instanceof Map).toBe(false);
    const { state, run, onSkip } = setup([]);
    state.settings = foreign;
    const { calls, record } = callTimes(run);
    record();
    await advance(3 * H);
    expect(calls).toEqual([1, 2, 3]);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("reads a Map subclass through Map.prototype, not its own get and has", async () => {
    const { state, run, onSkip } = setup([]);
    state.settings = new LyingMap([["backup.enabled", false]]);
    await advance(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(new Set(onSkip.mock.calls.flat())).toEqual(new Set(["disabled"]));
    // No interval key: the default 24 h, not the subclass's word that one is there.
    state.settings = new LyingMap([["backup.enabled", true]]);
    await advance(24 * H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([0, 25, 1.5, -0, "24", NaN, Infinity, true, null])(
    "enabled with interval_hours %s: interval_invalid, no run",
    async (interval) => {
      const { run, onSkip } = setup(on(interval));
      await advance(48 * H);
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
    await advance(hours * H - 1);
    expect(run).not.toHaveBeenCalled();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(2 * hours * H - 1);
    expect(run).toHaveBeenCalledTimes(2);
    await advance(1);
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
      await advance(100 * H);
      state.settings = new Map(on(6));
      await advance(6 * H - 1);
      expect(run).not.toHaveBeenCalled();
      await advance(1);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("an invalid interval keeps counting: the run comes as soon as it is valid", async () => {
    const { state, run } = setup(on(0));
    await advance(10 * H);
    state.settings = new Map(on(2));
    await advance(H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // DAN-1012-2a (option A, Ductus#2028 c.6965242237): run() is called on a
  // fixed hourly grid from start(); the job's own timing never moves it.

  it.each([1, 5, 24])("interval %s: every call is on the grid", async (interval) => {
    const { run } = setup(on(interval));
    const { calls, record } = callTimes(run);
    record();
    await advance(3 * interval * H);
    expect(calls).toEqual([interval, 2 * interval, 3 * interval]);
  });

  // QA FAIL 2 on #283 (30a28bf): a job that takes 5 min does not move the next call.
  it.each([1, 2])(
    "a synchronous 5 min job: interval %s, the next call stays on the grid",
    async (interval) => {
      const { run } = setup(on(interval));
      const { calls, record } = callTimes(run);
      record(() => vi.advanceTimersByTime(5 * 60_000));
      await advance(3 * interval * H);
      expect(calls).toEqual([interval, 2 * interval, 3 * interval]);
    },
  );

  // Review and QA FAIL 1 on #283 (30a28bf): the job's own preparation is its own.
  it("an asynchronous 5 min preparation: calls stay on the grid", async () => {
    const { run } = setup(on(1));
    const { calls, record } = callTimes(run);
    record(() => new Promise((resolve) => setTimeout(resolve, 5 * 60_000)));
    await advance(3 * H);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("a read under an hour delays only its own call, not the grid", async () => {
    const { readSettings, run } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 0.75 * H)),
    );
    await advance(3 * H);
    expect(calls).toEqual([1.75, 2, 3]);
  });

  it("a read past the next tick calls nothing: no call leaves its own hour", async () => {
    const { readSettings, run, onSkip } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 1.5 * H)),
    );
    await advance(3 * H);
    expect(calls).toEqual([3]);
    expect(onSkip.mock.calls).toEqual([["busy"], ["settings_unavailable"]]);
  });

  // QA attacker on #289 (84f6f59): a read that ends exactly at the next tick,
  // before that tick's callback runs, must not call run() a second time there.
  it("a read ending exactly at the next tick, first in line, calls nothing", async () => {
    let release!: (value: unknown) => void;
    const first = new Promise((resolve) => (release = resolve));
    // Created before start(): at 2 h this timer runs before the scheduler's.
    setTimeout(() => release(new Map(on(1))), 2 * H);
    const { readSettings, run, onSkip } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(() => first);
    await advance(3 * H);
    expect(calls).toEqual([2, 3]);
    expect(onSkip.mock.calls).toEqual([["settings_unavailable"]]);
  });

  // Review FAIL on #289 (f40f4f8): Node truncates a fractional delay, so a
  // timer can call back just before its point; that point must not count yet.
  it("a timer that calls back 1 ms early counts no point before it is due", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms: number) =>
        fakeSetTimeout(fn, ms >= 2 ? ms - 1 : ms)) as never);
    try {
      const { run } = setup(on(1));
      const { calls, record } = callTimes(run);
      record();
      await advance(3 * H + 2);
      expect(calls.length).toBe(3);
      calls.forEach((at, i) => {
        expect(at).toBeGreaterThanOrEqual(i + 1);
        expect(at).toBeLessThan(i + 1 + 2 / H);
      });
    } finally {
      spy.mockRestore();
    }
  });

  // QA FAIL 2 on #289 (f40f4f8): a point due while a synchronous job blocked
  // the loop is busy, even when its callback only comes after the job.
  it("a point due during a synchronous job is busy, whenever its callback comes", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // The timer for point 2 runs only once the blocked loop is free again.
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 0.5 * H + 1 : ms);
    }) as never);
    try {
      const { readSettings, run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() => {
        if (calls.length === 1) vi.advanceTimersByTime(1.5 * H);
      });
      await advance(3 * H);
      // The job moved the clock to 2.5 h; three more hours bring it to 4.5 h.
      expect(calls).toEqual([1, 3, 4]);
      expect(onSkip.mock.calls).toEqual([["busy"]]);
      expect(readSettings).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  // Review FAIL on #289 (7d37ecf), DAN-1012-2b and 2c: stop() from any callback
  // stops what follows; a decision already made stands.
  it.each(["onSkip on busy", "onSkip on disabled", "readSettings", "run"] as const)(
    "stop() called synchronously from %s starts nothing more",
    async (from) => {
      const fakeSetTimeout = globalThis.setTimeout;
      let scheduled = 0;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => void,
        ms: number,
      ) => {
        scheduled += 1;
        // Point 2's timer comes at 3.5 h, after a job that blocked until 2.5 h.
        const late = from === "onSkip on busy" && scheduled === 2;
        return fakeSetTimeout(fn, late ? ms + 1.5 * H : ms);
      }) as never);
      try {
        const holder: { stopping?: Promise<void> | undefined } = {};
        const box: { stop?: () => Promise<void> } = {};
        const stopNow = () => (holder.stopping ??= box.stop?.());
        const { state, scheduler, readSettings, run } = setup(
          from === "onSkip on disabled" ? [["backup.enabled", false]] : on(1),
          {
            onSkip: (reason) => {
              if (from === "onSkip on busy" ? reason === "busy" : from === "onSkip on disabled")
                stopNow();
            },
          },
        );
        box.stop = () => scheduler.stop();
        if (from === "readSettings") {
          readSettings.mockImplementation(() => {
            stopNow();
            return state.settings;
          });
        }
        if (from === "onSkip on busy") {
          run.mockImplementationOnce(() => {
            vi.advanceTimersByTime(1.5 * H);
          });
        }
        if (from === "run") run.mockImplementation(() => void stopNow());
        await advance(6 * H);
        expect(holder.stopping).toBeDefined();
        await expect(holder.stopping).resolves.toBeUndefined();
        // On busy the listener runs after point 3's decision (DAN-1012-2c): that
        // check reads and calls run(); stop() stops only what follows.
        expect(readSettings).toHaveBeenCalledTimes(from === "onSkip on busy" ? 2 : 1);
        expect(run).toHaveBeenCalledTimes(from === "onSkip on busy" ? 2 : from === "run" ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // QA and Review FAIL on #289 (9822d62), DAN-1012-2b: a listener that blocks
  // the loop never changes a tick's decision, nor makes a later point busy.
  // Review FAIL on #299 (b25ba57), DAN-1012-2c: the listener runs after the
  // continuation of a read that has already resolved, so point 3 is called.
  it("an onSkip that blocks for an hour changes no decision once the read resolved", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's timer comes at 3.5 h (after a job until 2.5 h), point 4's at
      // 4.5 h (after the listener freed the loop).
      const extra = scheduled === 2 ? 1.5 * H : scheduled === 3 ? 0.5 * H + 1 : 0;
      return fakeSetTimeout(fn, ms + extra);
    }) as never);
    try {
      let blocked = false;
      const { run, onSkip } = setup(on(1), {
        onSkip: (reason) => {
          if (reason === "busy" && !blocked) {
            blocked = true;
            vi.advanceTimersByTime(H);
          }
        },
      });
      const { calls, record } = callTimes(run);
      record(() => {
        if (calls.length === 1) vi.advanceTimersByTime(1.5 * H);
      });
      // 5 h here, plus the job's 1.5 h and the listener's hour: 7.5 h in all.
      await advance(5 * H);
      expect(calls.map((at) => Math.round(at * 100) / 100)).toEqual([1, 3.5, 4.5, 5, 6, 7]);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // QA FAIL 2 on #299 (b25ba57): the end of a job is recorded before any
  // listener runs, so a second blocking listener does not make point 4 busy.
  it("a job settled by one listener ends before another listener blocks", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's timer comes at 3.5 h with points 2 and 3 both busy; point
      // 4's at 4.5 h, after the second listener freed the loop.
      const extra = scheduled === 2 ? 1.5 * H : scheduled === 3 ? 0.5 * H + 1 : 0;
      return fakeSetTimeout(fn, ms + extra);
    }) as never);
    try {
      const hang = deferred();
      let busyCount = 0;
      const { run } = setup(on(1), {
        onSkip: (reason) => {
          if (reason !== "busy") return;
          busyCount += 1;
          if (busyCount === 1) hang.resolve();
          if (busyCount === 2) vi.advanceTimersByTime(H);
        },
      });
      const { calls, record } = callTimes(run);
      record(() => (calls.length === 1 ? hang.promise : undefined));
      await advance(5 * H);
      expect(busyCount).toBe(2);
      expect(calls.map((at) => Math.round(at * 100) / 100)).toEqual([1, 4.5, 5, 6]);
    } finally {
      spy.mockRestore();
    }
  });

  // DAN-1012-2c, a known limit of the port: a listener that blocks while a
  // read is still pending is read delay. Point 3's read needs 10 min, but the
  // listener holds the loop for an hour first, so the late-read rule refuses it.
  it("a listener that blocks while a read is pending counts as read delay", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's timer comes at 3.5 h, after a job that blocked until 2.5 h.
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 1.5 * H : ms);
    }) as never);
    try {
      let blocked = false;
      const reasons: string[] = [];
      const { readSettings, run } = setup(on(1), {
        onSkip: (reason) => {
          reasons.push(reason);
          if (reason === "busy" && !blocked) {
            blocked = true;
            vi.advanceTimersByTime(H);
          }
        },
      });
      const { calls, record } = callTimes(run);
      record(() => {
        if (calls.length === 1) vi.advanceTimersByTime(1.5 * H);
      });
      readSettings.mockImplementationOnce(() => new Map(on(1)));
      readSettings.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(new Map(on(1))), 10 * 60_000)),
      );
      await advance(3 * H);
      // 3 h here, plus the job's 1.5 h and the listener's hour: 5.5 h in all.
      // Point 3's read is late, point 4 comes while it is pending: no call
      // until point 5.
      expect(calls.map((at) => Math.round(at * 100) / 100)).toEqual([1, 5]);
      expect(reasons).toContain("settings_unavailable");
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["rejects", () => Promise.reject(new Error(CANARY))],
  ])("an onSkip that %s changes no decision: calls stay on the grid", async (_k, failing) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { state, run } = setup([["backup.enabled", false]], { onSkip: failing });
      const { calls, record } = callTimes(run);
      record();
      await advance(3 * H);
      state.settings = new Map(on(2));
      await advance(5 * H);
      expect(calls).toEqual([5, 7]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("points missed by a blocked event loop count at once, without extra reads", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementationOnce(((fn: () => void, ms: number) =>
        fakeSetTimeout(fn, ms + 2.5 * H)) as never);
    try {
      const { readSettings, run, onSkip } = setup(on(3));
      const { calls, record } = callTimes(run);
      record();
      await advance(6 * H);
      expect(calls).toEqual([3.5, 6]);
      expect(readSettings).toHaveBeenCalledTimes(4);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a late read that sees backup off does not restart the count", async () => {
    const { state, readSettings, run } = setup(on(2));
    const { calls, record } = callTimes(run);
    record();
    readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Map([["backup.enabled", false]])), 1.5 * H),
        ),
    );
    await advance(2.5 * H);
    state.settings = new Map(on(2));
    await advance(H);
    expect(calls).toEqual([3]);
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
    await advance(1.75 * H);
    state.settings = new Map(on(2));
    await advance(2.25 * H);
    expect(calls).toEqual([3]);
  });

  it("a run that throws synchronously is run_failed and still resets the hours", async () => {
    const { run, onSkip } = setup(on(2));
    run.mockImplementationOnce(() => {
      throw new Error(CANARY);
    });
    await advance(4 * H - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["run_failed"]]);
  });

  it("turned off, no run from the next hour", async () => {
    const { state, run } = setup(on(1));
    await advance(3 * H);
    state.settings = new Map([["backup.enabled", false]]);
    await advance(48 * H);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("a changed interval counts from the last run", async () => {
    const { state, run } = setup(on(24));
    await advance(10 * H);
    state.settings = new Map(on(6));
    await advance(H);
    expect(run).toHaveBeenCalledTimes(1);
    state.settings = new Map(on(24));
    await advance(24 * H - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("unavailable then available again: one run, no catching up", async () => {
    const { state, run } = setup(on(2));
    state.settings = undefined;
    await advance(10 * H);
    state.settings = new Map(on(2));
    await advance(H);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a run longer than an hour is busy: the busy hour reads nothing, no second run", async () => {
    const hang = deferred();
    const { readSettings, run, onSkip } = setup(on(1));
    const { calls, record } = callTimes(run);
    record();
    run.mockImplementationOnce(() => {
      calls.push(1);
      return hang.promise;
    });
    await advance(3.5 * H);
    expect(calls).toEqual([1]);
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["busy"], ["busy"]]);
    hang.resolve();
    await advance(0.5 * H);
    expect(calls).toEqual([1, 4]);
  });

  it("busy hours count toward the next interval", async () => {
    const hang = deferred();
    const { run } = setup(on(3));
    run.mockImplementationOnce(() => hang.promise);
    await advance(5 * H);
    hang.resolve();
    await advance(H);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reads no wall clock", async () => {
    const { run } = setup(on(2));
    vi.setSystemTime(Date.now() + 100 * H);
    await advance(H);
    vi.setSystemTime(Date.now() - 1000 * H);
    expect(run).not.toHaveBeenCalled();
    await advance(H);
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
    await advance(4 * H);
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
      await advance(5 * H);
      state.settings = new Map(on(1));
      await advance(H);
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
    const { scheduler } = setup(on(1), { run: () => options.run() as Promise<void> });
    options.run = () => {
      calls += 1;
      stopping = scheduler.stop();
      return finish(hang.promise);
    };
    let stopped = false;
    await advance(H);
    expect(stopping).toBeDefined();
    void stopping?.then(() => (stopped = true));
    await advance(0);
    expect(stopped).toBe(false);
    hang.resolve();
    // A rejected job queues run_failed; stop() resolves once it was handed over.
    await advance(1);
    await stopping;
    expect(stopped).toBe(true);
    await advance(10 * H);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
  });

  // QA attacker on 2c (c605ec0): a reason queued before stop() ends reaches
  // onSkip before stop() resolves, so a logger closed after it loses nothing.
  it("stop() resolves only after the last reasons reached onSkip", async () => {
    const hang = deferred();
    const { run, onSkip, scheduler } = setup(on(1));
    run.mockImplementationOnce(() => hang.promise.then(() => Promise.reject(new Error(CANARY))));
    await advance(H);
    const order: string[] = [];
    onSkip.mockImplementation((reason: string) => void order.push(reason));
    const stopping = scheduler.stop().then(() => order.push("stopped"));
    hang.resolve();
    await advance(1);
    await stopping;
    expect(order).toEqual(["run_failed", "stopped"]);
  });

  // QA attacker on 2c (c605ec0): a hostile promise from a callback never
  // becomes an unhandled rejection.
  it.each([
    [
      "onSkip with its own catch",
      (p: Promise<never>) => Object.defineProperty(p, "catch", { value: () => p }),
    ],
    [
      "run with its own catch and then",
      (p: Promise<never>) => Object.assign(p, { catch: () => p, then: undefined }),
    ],
  ])("a rejected promise from %s is never unhandled", async (name, tamper) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const hostile = () => tamper(Promise.reject(new Error(CANARY)));
      const fromOnSkip = name.startsWith("onSkip");
      // A plain function, not a spy: a spy would itself observe the promise.
      const { scheduler } = setup(fromOnSkip ? [["backup.enabled", false]] : on(1), {
        ...(fromOnSkip ? { onSkip: hostile } : { run: hostile }),
      });
      await advance(3 * H);
      await scheduler.stop();
      await realTurn();
      await realTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  // QA attacker on 2c (c605ec0): a point due exactly when the job ended is not
  // busy (the job is over), so its callback reads and calls.
  it("a point due exactly at the end of a job is not busy", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's callback comes 1 ms after a job that ended exactly at 2 h.
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 1 : ms);
    }) as never);
    try {
      const { run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() => {
        if (calls.length === 1) vi.advanceTimersByTime(H);
      });
      // 2 h here plus the job's hour: points 1, 2 (just after the job) and 3.
      await advance(2 * H);
      expect(calls.length).toBe(3);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // QA FAIL on #306 (dfca637), DAN-1012-2d: the end of a synchronous job is
  // recorded at its return, not after unrelated microtasks queued ahead of
  // the await.
  it("a synchronous job that ends before point 2 is not busy behind a 20 ms microtask", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's callback comes 15 ms late, after the 20 ms microtask.
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const { readSettings, run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record();
      // Point 1's read resolves 10 ms before point 2, then other code holds
      // the thread for 20 ms in a microtask queued right after it.
      readSettings.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            fakeSetTimeout(() => {
              resolve(new Map(on(1)));
              queueMicrotask(() => vi.advanceTimersByTime(20));
            }, H - 10),
          ),
      );
      await advance(2.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([2, 2]);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // DAN-1012-2d: a job's promise that settles 10 ms before point 2 records its
  // end in its first reaction, ahead of a 20 ms microtask queued after it.
  it("a job promise that settles before point 2 is not busy behind a later microtask", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const { run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() =>
        calls.length === 1
          ? new Promise<void>((resolve) =>
              fakeSetTimeout(() => {
                resolve();
                queueMicrotask(() => vi.advanceTimersByTime(20));
              }, H - 10),
            )
          : undefined,
      );
      await advance(2.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([1, 2]);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // The negative of the case above: a job that really ends after point 2
  // keeps that point busy.
  it("a job that really ends 10 ms after point 2 keeps point 2 busy", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const { readSettings, run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() => {
        if (calls.length === 1) vi.advanceTimersByTime(20);
      });
      readSettings.mockImplementationOnce(
        () => new Promise((resolve) => fakeSetTimeout(() => resolve(new Map(on(1))), H - 10)),
      );
      await advance(3.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([2, 3]);
      expect(onSkip.mock.calls).toEqual([["busy"]]);
    } finally {
      spy.mockRestore();
    }
  });

  it("stop waits for the run in progress and leaves no timer", async () => {
    const hang = deferred();
    const { run, scheduler } = setup(on(1));
    run.mockImplementationOnce(() => hang.promise);
    await advance(H);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await advance(0);
    expect(stopped).toBe(false);
    hang.resolve();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    scheduler.start();
    await advance(10 * H);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an interval key present with the value undefined is interval_invalid", async () => {
    const { run, onSkip } = setup([
      ["backup.enabled", true],
      ["backup.interval_hours", undefined],
    ]);
    await advance(48 * H);
    expect(run).not.toHaveBeenCalled();
    expect(new Set(onSkip.mock.calls.flat())).toEqual(new Set(["interval_invalid"]));
  });

  it("stop does not wait for a settings read that never ends", async () => {
    const { scheduler, onSkip } = setup(on(1), {
      readSettings: () => new Promise(() => undefined),
    });
    await advance(3 * H);
    expect(onSkip.mock.calls).toEqual([["busy"], ["busy"]]);
    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a read that ends after stop starts no run", async () => {
    const read = deferred();
    const { run, scheduler } = setup(on(1), {
      readSettings: () => read.promise.then(() => new Map(on(1))),
    });
    await advance(H);
    const stopping = scheduler.stop();
    read.resolve();
    await stopping;
    await advance(10 * H);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer to the next grid point, never a reference on the process", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { state } = setup(on(1));
      await advance(3 * H);
      state.settings = new Map([["backup.enabled", false]]);
      await advance(3 * H);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
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

// DAN-1012-2e (contract Ductus#2028 c.6968668259): the attack class is the
// shape of run()'s result. Every row is a job that really ends 1.5 h after
// its call at 1 h, with interval 1 h; the scheduler follows one native promise
// of this realm, so no shape can end the job early or late.
describe("backup scheduler: every shape of run()'s result", () => {
  const later = (ms: number, fn: () => void) => void setTimeout(fn, ms);
  const block = () => vi.advanceTimersByTime(1.5 * H);
  const shapes: [string, () => unknown, boolean][] = [
    ["a native promise", () => new Promise<void>((resolve) => later(1.5 * H, resolve)), false],
    [
      "a promise from vm.runInNewContext",
      () =>
        runInNewContext("new Promise((resolve) => later(1.5 * hour, resolve))", { later, hour: H }),
      false,
    ],
    [
      "a vm promise with then: undefined",
      () =>
        runInNewContext(
          "Object.assign(new Promise((resolve) => later(1.5 * hour, resolve)), { then: undefined })",
          { later, hour: H },
        ),
      false,
    ],
    [
      "a promise of this realm with then: undefined",
      () =>
        Object.assign(new Promise<void>((resolve) => later(1.5 * H, resolve)), { then: undefined }),
      false,
    ],
    ["a non-native thenable", () => ({ then: (ok: () => void) => later(1.5 * H, ok) }), false],
    [
      "a standard Promise subclass",
      () => {
        class Job extends Promise<void> {}
        return new Job((resolve) => later(1.5 * H, resolve));
      },
      false,
    ],
    [
      "a thenable resolving with a nested thenable",
      () => ({
        then: (ok: (value: unknown) => void) =>
          ok({ then: (inner: () => void) => later(1.5 * H, inner) }),
      }),
      false,
    ],
    [
      "a thenable that calls back twice, then fails",
      () => ({
        then: (ok: () => void, fail: (e: unknown) => void) =>
          later(1.5 * H, () => {
            ok();
            ok();
            fail(new Error(CANARY));
          }),
      }),
      false,
    ],
    [
      "a thenable that throws from then",
      () => ({
        then: () => {
          block();
          throw new Error(CANARY);
        },
      }),
      true,
    ],
    [
      "a synchronous throw",
      () => {
        block();
        throw new Error(CANARY);
      },
      true,
    ],
    ["a synchronous return", () => void block(), false],
    [
      "a rejected promise",
      () => new Promise((_, reject) => later(1.5 * H, () => reject(new Error(CANARY)))),
      true,
    ],
  ];

  // A plain function, not a spy: a spy would itself observe the result.
  const plainRun = (job: () => unknown) => {
    const t0 = performance.now();
    const calls: number[] = [];
    const run = (): Promise<void> | undefined => {
      calls.push((performance.now() - t0) / H);
      return calls.length === 1 ? (job() as Promise<void>) : undefined;
    };
    // A synchronous row moves the clock itself, so advance to a time from t0.
    const until = (at: number) => advance(Math.max(0, t0 + at * H - performance.now()) + ahead);
    return { calls, run, until };
  };

  it.each(shapes)(
    "%s: no second job while it runs, busy then the next hour",
    async (_n, job, fails) => {
      const { calls, run, until } = plainRun(job);
      const { onSkip, readSettings } = setup(on(1), { run });
      await until(1);
      await until(2.5 - 1 / H);
      expect(calls).toEqual([1]);
      await until(3.5);
      expect(calls).toEqual([1, 3]);
      expect(readSettings).toHaveBeenCalledTimes(2);
      expect(onSkip.mock.calls).toEqual(fails ? [["busy"], ["run_failed"]] : [["busy"]]);
    },
  );

  it.each(shapes)("%s: stop() called inside the job waits for its end", async (_n, job, fails) => {
    const order: string[] = [];
    const box: { stop?: () => Promise<void>; stopping?: Promise<void> | undefined } = {};
    const { calls, run, until } = plainRun(() => {
      box.stopping = box.stop?.().then(() => void order.push(`stopped at ${calls.length}`));
      stoppedAt.started = performance.now();
      return job();
    });
    const stoppedAt = { started: 0 };
    const { scheduler } = setup(on(1), { run, onSkip: (reason) => void order.push(reason) });
    box.stop = () => scheduler.stop();
    let resolvedAt = 0;
    await until(1);
    await until(2.5 - 1 / H);
    expect(box.stopping).toBeDefined();
    void box.stopping?.then(() => (resolvedAt = performance.now()));
    await until(3.5);
    await box.stopping;
    // Resolved only once the job had run its 1.5 h.
    expect(resolvedAt - stoppedAt.started).toBeGreaterThanOrEqual(1.5 * H);
    expect(order).toEqual(fails ? ["run_failed", "stopped at 1"] : ["stopped at 1"]);
    expect(calls).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a native promise whose then.call throws (hostile species) is run_failed, not a hang", async () => {
    const { run, onSkip } = setup(on(1));
    const hostile = Object.defineProperty(Promise.resolve(), "constructor", {
      get: () => {
        throw new Error(CANARY);
      },
    });
    run.mockImplementationOnce(() => hostile);
    await advance(2 * H);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["run_failed"]]);
  });

  // QA attacker on #312 (06c08fa): a native promise already settled when run()
  // returns ends at the return, like a synchronous job, not in a reaction
  // queued behind a 20 ms microtask that other code queued earlier.
  it.each([
    ["a synchronous return", () => undefined, false],
    ["Promise.resolve()", () => Promise.resolve(), false],
    ["an async function that returns at once", async () => undefined, false],
    [
      "a vm promise already resolved, with then: undefined",
      () => runInNewContext("Object.assign(Promise.resolve(), { then: undefined })"),
      false,
    ],
    ["Promise.reject()", () => Promise.reject(new Error(CANARY)), true],
  ])(
    "%s, 10 ms before point 2 behind a 20 ms microtask: point 2 is not busy",
    async (_n, job, fails) => {
      const fakeSetTimeout = globalThis.setTimeout;
      let scheduled = 0;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => void,
        ms: number,
      ) => {
        scheduled += 1;
        // Point 2's callback comes 15 ms late, after the 20 ms microtask.
        return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
      }) as never);
      try {
        const t0 = performance.now();
        const calls: number[] = [];
        const { readSettings, onSkip } = setup(on(1), {
          run: () => {
            calls.push((performance.now() - t0) / H);
            return calls.length === 1 ? (job() as Promise<void>) : undefined;
          },
        });
        readSettings.mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              fakeSetTimeout(() => {
                resolve(new Map(on(1)));
                queueMicrotask(() => vi.advanceTimersByTime(20));
              }, H - 10),
            ),
        );
        await advance(2.5 * H);
        expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([2, 2]);
        expect(onSkip.mock.calls).toEqual(fails ? [["run_failed"]] : []);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // A thenable's end comes in the reaction to its call back, ahead of a 20 ms
  // microtask queued after it: point 2 is not busy (the 2d case for PromiseLike).
  it("a thenable that calls back 10 ms before point 2 is not busy behind a later microtask", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const { run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() =>
        calls.length === 1
          ? {
              then: (ok: () => void) =>
                fakeSetTimeout(() => {
                  ok();
                  queueMicrotask(() => vi.advanceTimersByTime(20));
                }, H - 10),
            }
          : undefined,
      );
      await advance(2.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([1, 2]);
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// Measure 4 (DAN-1012-2e): ordering scenarios on the fake clock around a job of 1.5 h.
describe("backup scheduler: ordering around a 1.5 h job", () => {
  const longJob = () => new Promise<void>((resolve) => setTimeout(resolve, 1.5 * H));

  it("a tick during the job is busy and reads nothing; the next call is on the grid", async () => {
    const { run, onSkip, readSettings } = setup(on(1));
    const { calls, record } = callTimes(run);
    record(() => (calls.length === 1 ? longJob() : undefined));
    await advance(2 * H);
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["busy"]]);
    await advance(2 * H);
    expect(calls).toEqual([1, 3, 4]);
  });

  it("stop() from outside during the job resolves only at its end", async () => {
    const { run, scheduler } = setup(on(1));
    run.mockImplementationOnce(longJob);
    await advance(1.5 * H);
    let stoppedAt: number | undefined;
    const t = performance.now();
    const stopping = scheduler.stop().then(() => (stoppedAt = performance.now() - t));
    await advance(H - 1);
    expect(stoppedAt).toBeUndefined();
    await advance(1);
    await stopping;
    expect(stoppedAt).toBe(H);
    await advance(10 * H);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backup turned off during the job: no call after it ends", async () => {
    const { state, run, onSkip } = setup(on(1));
    run.mockImplementationOnce(longJob);
    await advance(1.5 * H);
    state.settings = new Map([["backup.enabled", false]]);
    await advance(3 * H);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip.mock.calls).toEqual([["busy"], ["disabled"], ["disabled"]]);
  });
});

// Known limits of DAN-1012-2e (README): a value that is not a native promise
// but answers to Promise.prototype.then, or a native promise on which that
// then throws, counts as a job that failed at once. These rows pin that
// behaviour, so a change to it is a decision, not an accident.
describe("backup scheduler: results the scheduler does not follow", () => {
  const pending = () => new Promise<void>(() => undefined);
  it.each([
    ["a Proxy of a native promise", () => new Proxy(pending(), {})],
    ["an object inheriting from a native promise", () => Object.create(pending()) as unknown],
    [
      "a Promise subclass whose constructor ignores its executor",
      () => {
        class Odd extends Promise<void> {
          constructor() {
            super(() => undefined);
          }
        }
        return new Odd();
      },
    ],
  ])("%s: run_failed at once, the scheduler goes on", async (_n, result) => {
    const { run, onSkip } = setup(on(1));
    run.mockImplementationOnce(result);
    await advance(2 * H);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["run_failed"]]);
  });

  it("reads a thenable's then exactly once", async () => {
    let reads = 0;
    const { run, onSkip } = setup(on(1));
    run.mockImplementationOnce(() => ({
      get then() {
        reads += 1;
        return (ok: () => void) => ok();
      },
    }));
    await advance(H);
    expect(reads).toBe(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  // Review and QA FAIL on #312 (baf01da): a promise settled while its reaction
  // is being registered (here by a constructor getter that moves the clock
  // past point 2) ends when the registration returns, not at run()'s return.
  it("a promise settled during registration ends after it: point 2 is busy", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const t0 = performance.now();
      const calls: number[] = [];
      const { readSettings, onSkip } = setup(on(1), {
        run: () => {
          calls.push((performance.now() - t0) / H);
          if (calls.length > 1) return undefined;
          let resolve!: () => void;
          const job = new Promise<void>((r) => (resolve = r));
          return Object.defineProperty(job, "constructor", {
            get: () => {
              vi.advanceTimersByTime(20);
              resolve();
              return Promise;
            },
          });
        },
      });
      readSettings.mockImplementationOnce(
        () => new Promise((resolve) => fakeSetTimeout(() => resolve(new Map(on(1))), H - 10)),
      );
      await advance(3.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([2, 3]);
      expect(onSkip.mock.calls).toEqual([["busy"]]);
    } finally {
      spy.mockRestore();
    }
  });

  // Known limit (README): a pending promise's resolve is seen only in its
  // reaction, behind microtasks other code queued before the resolve. The end
  // is then late, which can only make a point busy, never start a second job.
  it("a pending promise resolved behind an earlier 20 ms microtask ends late: busy, no overlap", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 15 : ms);
    }) as never);
    try {
      const { run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() =>
        calls.length === 1
          ? new Promise<void>((resolve) =>
              fakeSetTimeout(() => {
                queueMicrotask(() => vi.advanceTimersByTime(20));
                resolve();
              }, H - 10),
            )
          : undefined,
      );
      await advance(3.5 * H);
      expect(calls.map((at) => Math.round(at * 1000) / 1000)).toEqual([1, 3]);
      expect(onSkip.mock.calls).toEqual([["busy"]]);
    } finally {
      spy.mockRestore();
    }
  });

  // QA attacker on #312 (06c08fa): the probe that tells a promise settled at
  // return applies only to that case; a pending one ends when it settles, so
  // a point due during it is busy even when its callback comes after the end.
  it("a point due during a 1.5 h promise job is busy, whenever its callback comes", async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      scheduled += 1;
      // Point 2's callback comes only after the job ended at 2.5 h.
      return fakeSetTimeout(fn, scheduled === 2 ? ms + 0.5 * H + 1 : ms);
    }) as never);
    try {
      const { run, onSkip } = setup(on(1));
      const { calls, record } = callTimes(run);
      record(() =>
        calls.length === 1
          ? new Promise<void>((resolve) => fakeSetTimeout(resolve, 1.5 * H))
          : undefined,
      );
      await advance(3.5 * H);
      expect(calls).toEqual([1, 3]);
      expect(onSkip.mock.calls).toEqual([["busy"]]);
    } finally {
      spy.mockRestore();
    }
  });

  // QA attacker on #312 (06c08fa): every function the scheduler follows a job
  // with is taken at load, so a job that replaces one is still followed.
  it.each([
    [
      "util.types.isPromise",
      () => {
        const original = types.isPromise;
        types.isPromise = (() => false) as never;
        return () => (types.isPromise = original);
      },
    ],
    [
      "Promise.resolve",
      () => {
        const original = Promise.resolve;
        Promise.resolve = (() => original.call(Promise, undefined)) as never;
        return () => (Promise.resolve = original);
      },
    ],
    [
      "Reflect.apply",
      () => {
        const original = Reflect.apply;
        Reflect.apply = (() => undefined) as never;
        return () => (Reflect.apply = original);
      },
    ],
  ])("a job that replaces %s is still followed to its end", async (name, patch) => {
    const restore: (() => unknown)[] = [];
    const { run, onSkip } = setup(on(1));
    const { calls, record } = callTimes(run);
    record(() => {
      if (calls.length > 1) return undefined;
      restore.push(patch());
      // Promise.resolve is used only for a result that is not a native promise.
      if (name === "Promise.resolve") {
        return { then: (ok: () => void) => void setTimeout(ok, 1.5 * H) } as unknown;
      }
      return runInNewContext(
        "Object.assign(new Promise((resolve) => later(1.5 * hour, resolve)), { then: undefined })",
        { later: (ms: number, fn: () => void) => void setTimeout(fn, ms), hour: H },
      ) as unknown;
    });
    try {
      await advance(H);
    } finally {
      restore.forEach((undo) => undo());
    }
    await advance(2.5 * H);
    expect(calls).toEqual([1, 3]);
    expect(onSkip.mock.calls).toEqual([["busy"]]);
  });

  // Review and QA FAIL on #312 (baf01da): stop() waits for the reasons with
  // no Promise static a job may replace, so run_failed is handed over first.
  it("a job that replaces Promise.resolve, calls stop() and rejects: stop waits for run_failed", async () => {
    const original = Promise.resolve;
    const order: string[] = [];
    const box: { stop?: () => Promise<void> } = {};
    const { scheduler } = setup(on(1), {
      onSkip: (reason) => void order.push(reason),
      run: () => {
        Promise.resolve = (() => original.call(Promise, undefined)) as never;
        void box.stop?.().then(() => order.push("stopped"));
        return new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(CANARY)), 0.5 * H),
        );
      },
    });
    box.stop = () => scheduler.stop();
    try {
      await advance(2 * H);
      await advance(1);
    } finally {
      Promise.resolve = original;
    }
    await advance(1);
    expect(order).toEqual(["run_failed", "stopped"]);
  });

  // Review and QA FAIL on #312 (baf01da): stop() resolves only once every
  // reason on its way has been handed over, not after the first of them.
  it("stop() waits for two reasons on their way at once: busy and run_failed", async () => {
    const order: string[] = [];
    const box: { stop?: () => Promise<void> } = {};
    const { scheduler } = setup(on(1), {
      onSkip: (reason) => void order.push(reason),
      run: () =>
        // At 2 h, after point 2's busy is queued and before it is handed over,
        // stop() is called and the job rejects, which queues run_failed.
        new Promise<void>((_, reject) =>
          setTimeout(() => {
            void box.stop?.().then(() => order.push("stopped"));
            reject(new Error(CANARY));
          }, H),
        ),
    });
    box.stop = () => scheduler.stop();
    await advance(3 * H);
    expect(order).toEqual(["busy", "run_failed", "stopped"]);
  });

  it("a job that patches Promise.prototype.then is still followed to its end", async () => {
    const original = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
    const { run, onSkip } = setup(on(1));
    run.mockImplementationOnce(() => {
      Promise.prototype.then = function then(this: unknown) {
        return this;
      } as never;
      return new Promise<void>((resolve) => setTimeout(resolve, 1.5 * H));
    });
    try {
      await advance(H);
    } finally {
      if (original) Object.defineProperty(Promise.prototype, "then", original);
    }
    await advance(2.5 * H);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls).toEqual([["busy"]]);
  });
});
