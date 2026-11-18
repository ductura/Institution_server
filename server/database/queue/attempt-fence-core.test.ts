import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimKill,
  createDeadlines,
  KILLING,
  MAX_FENCE_MS,
  watchOnce,
  watchStep,
} from "./attempt-fence-core.ts";

// DAN-822-5a (contract cut on ductura/server#265, c.6964701401): the deadline
// is exact as a class. A fake clock (nanoseconds) and a real shared cell, no
// thread: no tolerance before the deadline, and every race is a fixed order
// of calls. The watch thread runs exactly these decisions.
const MS = 1_000_000n;
const T0 = 10_000_000_000n;

// A late release parks the main thread for good; here park throws, so a test
// sees that nothing after the release runs.
const PARKED = "parked_until_killed";
function park(): never {
  throw new Error(PARKED);
}

function fixture(start = T0): {
  cell: BigInt64Array;
  clock: { now: bigint };
  arm: (ms: number) => () => void;
} {
  const cell = new BigInt64Array(new SharedArrayBuffer(8));
  const clock = { now: start };
  const { arm } = createDeadlines(cell, () => clock.now, park);
  return { cell, clock, arm };
}

afterEach(() => vi.restoreAllMocks());

describe("watchStep: never a kill before the deadline", () => {
  const at = T0 + 300n * MS;
  it.each<[string, bigint]>([
    ["1 ns", 1n],
    ["just under 1 ms", MS - 1n],
    ["exactly 1 ms", MS],
    ["just over 1 ms", MS + 1n],
    ["the longest time", BigInt(MAX_FENCE_MS) * MS],
  ])("waits, never kills, with %s left, and wakes no earlier than the deadline", (_label, left) => {
    const step = watchStep(at, at - left);
    expect(step.kind).toBe("wait");
    if (step.kind !== "wait") return;
    expect(step.ms).toBeGreaterThanOrEqual(1);
    expect(BigInt(step.ms) * MS).toBeGreaterThanOrEqual(left);
    expect(BigInt(step.ms - 1) * MS).toBeLessThan(left);
  });

  it("kills exactly at the deadline and after it", () => {
    expect(watchStep(at, at)).toEqual({ kind: "kill", at });
    expect(watchStep(at, at + 1n)).toEqual({ kind: "kill", at });
  });

  it("is idle with nothing armed and once the kill is claimed", () => {
    expect(watchStep(0n, at)).toEqual({ kind: "idle" });
    expect(watchStep(KILLING, at)).toEqual({ kind: "idle" });
  });
});

describe("release: never survival past the deadline", () => {
  it.each<[string, bigint]>([
    ["at the deadline", 0n],
    ["1 ns after it", 1n],
    ["long after it", 60_000n * MS],
  ])("a release %s keeps the deadline, never returns, and the watch kills", (_label, late) => {
    const { cell, clock, arm } = fixture();
    const release = arm(300);
    const at = T0 + 300n * MS;
    clock.now = at + late;
    expect(() => release()).toThrow(PARKED);
    expect(Atomics.load(cell, 0)).toBe(at);
    expect(watchStep(Atomics.load(cell, 0), clock.now)).toEqual({ kind: "kill", at });
    expect(claimKill(cell, at)).toBe(true);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
  });

  it("a release 1 ns before the deadline clears it", () => {
    const { cell, clock, arm } = fixture();
    const release = arm(300);
    clock.now = T0 + 300n * MS - 1n;
    release();
    expect(Atomics.load(cell, 0)).toBe(0n);
    expect(watchStep(Atomics.load(cell, 0), T0 + 300n * MS)).toEqual({ kind: "idle" });
  });

  it("the later of two is fenced at its own time once the earlier is released", () => {
    const { cell, clock, arm } = fixture();
    const first = arm(300);
    arm(1500);
    const later = T0 + 1500n * MS;
    clock.now = T0 + 100n * MS;
    first();
    expect(Atomics.load(cell, 0)).toBe(later);
    expect(watchStep(Atomics.load(cell, 0), later - 1n).kind).toBe("wait");
    expect(watchStep(Atomics.load(cell, 0), later)).toEqual({ kind: "kill", at: later });
  });

  it("a later arm leaves the cell, an earlier one replaces it, a second release clears no other time", () => {
    const { cell, clock, arm } = fixture();
    const middle = arm(1000);
    arm(5000);
    expect(Atomics.load(cell, 0)).toBe(T0 + 1000n * MS);
    const early = arm(200);
    expect(Atomics.load(cell, 0)).toBe(T0 + 200n * MS);
    clock.now = T0 + 50n * MS;
    early();
    early();
    expect(Atomics.load(cell, 0)).toBe(T0 + 1000n * MS);
    middle();
    expect(Atomics.load(cell, 0)).toBe(T0 + 5000n * MS);
  });
});

describe("the watch and a release racing on the cell", () => {
  it("a kill decided on a stale read is not claimed once a timely release published", () => {
    const { cell, clock, arm } = fixture();
    const first = arm(300);
    arm(1500);
    const stale = Atomics.load(cell, 0);
    clock.now = stale - 1n;
    first();
    // The watch read `stale` before the release and only now sees its time pass.
    expect(watchStep(stale, stale)).toEqual({ kind: "kill", at: stale });
    expect(claimKill(cell, stale)).toBe(false);
    expect(Atomics.load(cell, 0)).toBe(T0 + 1500n * MS);
  });

  it("a release, an earlier arm or a later arm that loses to a claimed kill does not overwrite it", () => {
    const { cell, clock, arm } = fixture();
    const release = arm(300);
    const at = T0 + 300n * MS;
    expect(claimKill(cell, at)).toBe(true);
    clock.now = at - 1n;
    release();
    expect(Atomics.load(cell, 0)).toBe(KILLING);
    arm(1);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
    arm(60_000);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
  });

  it("a release that read its clock in time, and published before the watch claimed, prevents the kill", () => {
    const { cell, clock, arm } = fixture();
    const release = arm(300);
    const at = T0 + 300n * MS;
    clock.now = at - 1n;
    release();
    // The watch only reaches its claim after the deadline: too late.
    expect(claimKill(cell, at)).toBe(false);
    expect(Atomics.load(cell, 0)).toBe(0n);
  });

  it("writes the cell only by compareExchange, from the value it last published or the time it read", () => {
    const exchange = vi.spyOn(Atomics, "compareExchange");
    const store = vi.spyOn(Atomics, "store");
    const { cell, clock, arm } = fixture();
    const release = arm(300);
    const at = T0 + 300n * MS;
    clock.now = at - 1n;
    release();
    arm(500);
    const next = clock.now + 500n * MS;
    claimKill(cell, next);
    expect(exchange.mock.calls).toEqual([
      [cell, 0, 0n, at],
      [cell, 0, at, 0n],
      [cell, 0, 0n, next],
      [cell, 0, next, KILLING],
    ]);
    expect(store).not.toHaveBeenCalled();
  });

  it("wakes the watch after every time it publishes, so an earlier time is not slept through", () => {
    const notify = vi.spyOn(Atomics, "notify");
    const { cell, clock, arm } = fixture();
    const later = arm(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    const earlier = arm(200);
    expect(notify).toHaveBeenCalledTimes(2);
    arm(5000);
    expect(notify).toHaveBeenCalledTimes(2);
    clock.now = T0 + 100n * MS;
    earlier();
    later();
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify.mock.calls.every(([target, index]) => target === cell && index === 0)).toBe(true);
  });

  // QA FAIL on #287 (c.6965184860): every notify follows a successful
  // exchange, and only then; a late release publishes nothing, so it does not notify.
  it("notifies only right after an exchange that published, never before it or without one", () => {
    const order: string[] = [];
    const exchange = Atomics.compareExchange.bind(Atomics);
    const wake = Atomics.notify.bind(Atomics);
    vi.spyOn(Atomics, "compareExchange").mockImplementation((cell, index, expected, value) => {
      const seen = exchange(cell as BigInt64Array, index, expected as bigint, value as bigint);
      order.push(seen === expected ? "published" : "lost");
      return seen;
    });
    vi.spyOn(Atomics, "notify").mockImplementation((cell, index, count) => {
      order.push("notify");
      return wake(cell, index, count);
    });
    const { clock, arm } = fixture();
    const first = arm(300);
    arm(1000);
    clock.now = T0 + 100n * MS;
    first();
    const late = arm(50);
    clock.now = T0 + 100n * MS + 50n * MS;
    expect(() => late()).toThrow(PARKED);
    expect(order).toEqual(["published", "notify", "published", "notify", "published", "notify"]);
  });
});

// Orchestrator cut of #287 (Ductus#2028 c.6965626274): a lost exchange never
// notifies. The watch claims the kill between the main thread's last publish
// and its next exchange; the publish from arm and from a timely release both
// lose, leave KILLING, and wake nothing. Falls to `notify` without checking
// the exchange's result.
describe("a publish that loses the cell to a claimed kill", () => {
  function recorder(): string[] {
    const order: string[] = [];
    const exchange = Atomics.compareExchange.bind(Atomics);
    const wake = Atomics.notify.bind(Atomics);
    vi.spyOn(Atomics, "compareExchange").mockImplementation((cell, index, expected, value) => {
      const seen = exchange(cell as BigInt64Array, index, expected as bigint, value as bigint);
      order.push(seen === expected ? `published ${value}` : `lost ${value}`);
      return seen;
    });
    vi.spyOn(Atomics, "notify").mockImplementation((cell, index, count) => {
      order.push("notify");
      return wake(cell, index, count);
    });
    return order;
  }

  function claimed(): {
    cell: BigInt64Array;
    clock: { now: bigint };
    arm: (ms: number) => () => void;
    first: () => void;
    at: bigint;
    kills: number[];
  } {
    const { cell, clock, arm } = fixture();
    const first = arm(300);
    arm(1000);
    const at = T0 + 300n * MS;
    const kills: number[] = [];
    watchOnce(cell, { now: () => at, wait: () => {}, kill: () => kills.push(1) });
    expect(kills).toEqual([1]);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
    return { cell, clock, arm, first, at, kills };
  }

  it("from arm: an earlier time loses the exchange, leaves KILLING, and does not notify", () => {
    const { cell, arm } = claimed();
    const order = recorder();
    arm(1);
    expect(order).toEqual([`lost ${T0 + MS}`]);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
  });

  it("from a timely release: the next time loses the exchange, leaves KILLING, and does not notify", () => {
    const { cell, clock, first, at } = claimed();
    const order = recorder();
    clock.now = at - 1n;
    first();
    expect(order).toEqual([`lost ${T0 + 1000n * MS}`]);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
  });
});

describe("watchOnce: the watch loop, one round on a fake clock", () => {
  function watch(cell: BigInt64Array, now: bigint): string[] {
    const done: string[] = [];
    watchOnce(cell, {
      now: () => now,
      wait: (value, ms) => done.push(`wait ${value} ${ms ?? "forever"}`),
      kill: () => done.push("kill"),
    });
    return done;
  }

  it("waits on the very value it judged, for the rounded-up remainder, before the deadline", () => {
    const { cell, arm } = fixture();
    arm(300);
    const at = T0 + 300n * MS;
    expect(watch(cell, at - 1n)).toEqual([`wait ${at} 1`]);
    expect(watch(cell, at - MS - 1n)).toEqual([`wait ${at} 2`]);
  });

  it("waits forever on an empty cell and on a claimed one, and never kills", () => {
    const cell = new BigInt64Array(new SharedArrayBuffer(8));
    expect(watch(cell, T0)).toEqual(["wait 0 forever"]);
    Atomics.store(cell, 0, KILLING);
    expect(watch(cell, T0)).toEqual([`wait ${KILLING} forever`]);
  });

  it("kills at the deadline by claiming that very time", () => {
    const { cell, arm } = fixture();
    arm(300);
    const at = T0 + 300n * MS;
    expect(watch(cell, at)).toEqual(["kill"]);
    expect(Atomics.load(cell, 0)).toBe(KILLING);
  });

  it("after a timely release replaced the time, the next round waits on the new one", () => {
    const { cell, clock, arm } = fixture();
    const first = arm(300);
    arm(1500);
    clock.now = T0 + 299n * MS;
    first();
    const later = T0 + 1500n * MS;
    expect(watch(cell, T0 + 300n * MS)).toEqual([`wait ${later} 1200`]);
  });

  // QA FAIL on #287 (c.6965184860): the cell changes inside the round, between
  // the watch's read and its decision, through watchOnce itself.
  it("does not kill when a timely release replaced the time between its read and its claim", () => {
    const { cell, clock, arm } = fixture();
    const first = arm(300);
    arm(1500);
    const at = T0 + 300n * MS;
    const done: string[] = [];
    watchOnce(cell, {
      now: () => {
        clock.now = at - 1n;
        first();
        return at;
      },
      wait: () => done.push("wait"),
      kill: () => done.push("kill"),
    });
    expect(done).toEqual([]);
    expect(Atomics.load(cell, 0)).toBe(T0 + 1500n * MS);
  });

  it("returns at once from a wait on the time it judged when an earlier one was published meanwhile", () => {
    const { cell, arm } = fixture();
    arm(1000);
    const old = T0 + 1000n * MS;
    const results: string[] = [];
    watchOnce(cell, {
      now: () => {
        arm(200);
        return T0;
      },
      wait: (value, ms) => {
        expect(value).toBe(old);
        results.push(Atomics.wait(cell, 0, value, ms));
      },
      kill: () => results.push("kill"),
    });
    expect(results).toEqual(["not-equal"]);
    expect(Atomics.load(cell, 0)).toBe(T0 + 200n * MS);
  });
});

describe("arm: only a time the cell holds exactly", () => {
  it.each<[string, unknown]>([
    ["zero", 0],
    ["a negative time", -5],
    ["a fraction", 0.5],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["minus infinity", Number.NEGATIVE_INFINITY],
    ["a string", "300"],
    ["null", null],
    ["nothing", undefined],
    ["a bigint", 300n],
    ["one past the longest time", MAX_FENCE_MS + 1],
    // In nanoseconds these wrap in the 64-bit cell (a negative time kills at once).
    ["a time that wraps the cell", 9_300_000_000_000],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
  ])("refuses %s, and the cell stays empty", (_label, value) => {
    const { cell, arm } = fixture();
    expect(() => arm(value as number)).toThrow("fence_refused");
    expect(Atomics.load(cell, 0)).toBe(0n);
  });

  it.each<[string, bigint]>([
    ["0 (nothing armed)", -MS],
    ["the claimed kill (-1)", -MS - 1n],
    ["a negative time", -10n * MS],
    ["past the 64-bit cell", 2n ** 63n - MS],
  ])("refuses a clock that would make the deadline %s", (_label, start) => {
    const { cell, arm } = fixture(start);
    expect(() => arm(1)).toThrow("fence_refused");
    expect(Atomics.load(cell, 0)).toBe(0n);
  });

  it("arms the largest time the cell holds, 2^63 - 1, to the nanosecond", () => {
    const { cell, arm } = fixture(2n ** 63n - 1n - MS);
    arm(1);
    expect(Atomics.load(cell, 0)).toBe(2n ** 63n - 1n);
  });

  it("imports nothing at run time, so the watch thread loads no other module", () => {
    const text = readFileSync(new URL("./attempt-fence-core.ts", import.meta.url), "utf8");
    expect(text.match(/^import (?!type )/gmu)).toBeNull();
    expect(text.match(/^export .* from /gmu)).toBeNull();
  });

  it.each([1, MAX_FENCE_MS])("arms for %i ms, to the nanosecond", (ms) => {
    const { cell, arm } = fixture();
    arm(ms);
    expect(Atomics.load(cell, 0)).toBe(T0 + BigInt(ms) * MS);
  });
});
