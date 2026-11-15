import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type Clock,
  createShutdownCoordinator,
  FLUSH_LOGS,
  installShutdown,
  SHUTDOWN_GRACE_MS,
  type ShutdownHook,
  type StopResult,
} from "./shutdown.ts";

// S-1B-c (DAN-778), port of Ductus src/server/shutdown.test.ts at d52a92c3
// (DAN-587): K1 to K8 for the coordinator, then the order of the shutdown
// (contract c.6893332476, I1 to I8). The clock is a manual one, so the
// deadline is exact.
function manualClock(): Clock & {
  advance(ms: number): void;
  pending(): number;
  block(ms: number): void;
} {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    now: () => now,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
    // Time passes while the event loop is blocked: no timer runs.
    block(ms) {
      now += ms;
    },
  };
}

async function settled(promise: Promise<StopResult>): Promise<StopResult | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => vi.restoreAllMocks());

describe("shutdown coordinator", () => {
  it("stays under the default 10 s grace of a container stop", () => {
    expect(SHUTDOWN_GRACE_MS).toBe(8_000);
  });

  it("K1: a request in flight holds stop() until it is released", async () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    const ticket = shutdown.begin();
    expect(ticket).not.toBeNull();
    const stopping = shutdown.stop();
    expect(shutdown.state()).toBe("draining");
    clock.advance(SHUTDOWN_GRACE_MS - 1);
    expect(await settled(stopping)).toBe("pending");
    ticket!.release();
    expect(await stopping).toEqual({ outcome: "drained" });
    expect(shutdown.state()).toBe("stopped");
    expect(clock.pending()).toBe(0);
  });

  it.each(["draining", "stopped"] as const)(
    "K3: no new request is accepted once %s",
    async (state) => {
      const shutdown = createShutdownCoordinator({ clock: manualClock() });
      const held = shutdown.begin();
      const stopping = shutdown.stop();
      if (state === "stopped") {
        held!.release();
        await stopping;
      }
      expect(shutdown.state()).toBe(state);
      expect(shutdown.begin()).toBeNull();
      expect(shutdown.active()).toBe(state === "draining" ? 1 : 0);
    },
  );

  it("K5: at the deadline it reports what is unfinished, and a late release changes nothing", async () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    const first = shutdown.begin();
    shutdown.begin();
    const stopping = shutdown.stop();
    clock.advance(SHUTDOWN_GRACE_MS);
    expect(await stopping).toEqual({ outcome: "deadline", unfinished: 2 });
    expect(shutdown.state()).toBe("stopped");
    first!.release();
    expect(await shutdown.stop()).toEqual({ outcome: "deadline", unfinished: 2 });
    expect(shutdown.active()).toBe(1);
  });

  it("K6: stop() is idempotent and arms one deadline", () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    shutdown.begin();
    const first = shutdown.stop();
    expect(shutdown.stop()).toBe(first);
    expect(clock.pending()).toBe(1);
  });

  it("K7 (I6): releasing the same ticket twice counts once and does not free another", async () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    const a = shutdown.begin()!;
    shutdown.begin();
    a.release();
    a.release();
    expect(shutdown.active()).toBe(1);
    const stopping = shutdown.stop();
    expect(await settled(stopping)).toBe("pending");
    clock.advance(SHUTDOWN_GRACE_MS);
    expect(await stopping).toEqual({ outcome: "deadline", unfinished: 1 });
  });

  it("K8: stop() with nothing in flight is drained at once and leaves no timer", async () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    shutdown.begin()!.release();
    expect(await shutdown.stop()).toEqual({ outcome: "drained" });
    expect(clock.pending()).toBe(0);
  });

  it("a ticket taken in the same step before stop() holds it, one taken after is refused", async () => {
    const shutdown = createShutdownCoordinator({ clock: manualClock() });
    const before = shutdown.begin();
    const stopping = shutdown.stop();
    expect(shutdown.begin()).toBeNull();
    expect(await settled(stopping)).toBe("pending");
    before!.release();
    expect(await stopping).toEqual({ outcome: "drained" });
  });

  // c3 contract (Ductus#1836 c.6895155382): a 503 owed while draining holds the drain.
  it("hold(): while draining it holds stop() until released", async () => {
    const shutdown = createShutdownCoordinator({ clock: manualClock() });
    const request = shutdown.begin()!;
    const stopping = shutdown.stop();
    const owed = shutdown.hold();
    expect(owed).not.toBeNull();
    request.release();
    expect(await settled(stopping)).toBe("pending");
    expect(shutdown.active()).toBe(1);
    owed!.release();
    owed!.release();
    expect(await stopping).toEqual({ outcome: "drained" });
  });

  it("hold(): null once stopped, and an unreleased hold expires with the deadline", async () => {
    const clock = manualClock();
    const shutdown = createShutdownCoordinator({ clock });
    const stopping = shutdown.stop();
    expect(await stopping).toEqual({ outcome: "drained" });
    expect(shutdown.hold()).toBeNull();

    const other = createShutdownCoordinator({ clock });
    other.begin();
    const draining = other.stop();
    other.hold();
    clock.advance(SHUTDOWN_GRACE_MS);
    expect(await draining).toEqual({ outcome: "deadline", unfinished: 2 });
    expect(other.hold()).toBeNull();
    expect(other.begin()).toBeNull();
  });
});

describe("installShutdown", () => {
  function setup(hooks: readonly ShutdownHook[] = [], graceMs = SHUTDOWN_GRACE_MS) {
    const clock = manualClock();
    const coordinator = createShutdownCoordinator({ clock, graceMs });
    const target = new EventEmitter();
    const exit = vi.fn();
    const log = vi.fn();
    const calls: string[] = [];
    const listener = {
      stopAccepting: vi.fn(() => calls.push("stopAccepting")),
      closeAllConnections: vi.fn(() => calls.push("closeAllConnections")),
    };
    const remove = installShutdown(target, { coordinator, listener, hooks, exit, clock, log });
    return { clock, coordinator, target, exit, log, listener, calls, remove };
  }
  const recording = (calls: string[], name: string): ShutdownHook => ({
    name,
    run: () => {
      calls.push(name);
    },
  });

  it("listens to SIGTERM and SIGINT once each and can be removed", () => {
    const { target, remove } = setup();
    expect(target.listenerCount("SIGTERM")).toBe(1);
    expect(target.listenerCount("SIGINT")).toBe(1);
    remove();
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
  });

  it.each(["SIGTERM", "SIGINT"])(
    "I2/I5: %s stops accepting, waits for the request, runs the hooks in order, exits 0",
    async (signal) => {
      const calls: string[] = [];
      const hooks = [recording(calls, "logs"), recording(calls, "databases")];
      const ctx = setup(hooks);
      const request = ctx.coordinator.begin()!;
      ctx.target.emit(signal);
      await turn();
      expect(ctx.listener.stopAccepting).toHaveBeenCalledTimes(1);
      expect(ctx.coordinator.begin()).toBeNull();
      expect(calls).toEqual([]);
      expect(ctx.exit).not.toHaveBeenCalled();
      request.release();
      await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalledWith(0));
      expect(calls).toEqual(["logs", "databases"]);
      expect(ctx.log).not.toHaveBeenCalled();
      expect(ctx.listener.closeAllConnections).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["SIGTERM", "SIGTERM"],
    ["SIGINT", "SIGTERM"],
    ["SIGTERM", "SIGINT"],
  ])("I5: %s then %s starts nothing new and keeps the deadline", async (first, second) => {
    const calls: string[] = [];
    const ctx = setup([recording(calls, "logs")]);
    const stop = vi.spyOn(ctx.coordinator, "stop");
    const request = ctx.coordinator.begin()!;
    ctx.target.emit(first);
    ctx.clock.advance(SHUTDOWN_GRACE_MS - 1);
    ctx.target.emit(second);
    ctx.target.emit(second);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.listener.stopAccepting).toHaveBeenCalledTimes(1);
    expect(ctx.clock.pending()).toBe(2);
    request.release();
    await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalled());
    expect(ctx.exit.mock.calls).toEqual([[0]]);
    expect(calls).toEqual(["logs"]);
  });

  it("I3/I4: a request unfinished at the deadline exits 1 once, closes every connection, runs no hook", async () => {
    const calls: string[] = [];
    const ctx = setup([recording(calls, "logs")]);
    const request = ctx.coordinator.begin()!;
    ctx.target.emit("SIGTERM");
    ctx.clock.advance(SHUTDOWN_GRACE_MS - 1);
    expect(ctx.exit).not.toHaveBeenCalled();
    ctx.clock.advance(1);
    await turn();
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(ctx.log.mock.calls).toEqual([["shutdown.deadline", { phase: "requests", requests: 1 }]]);
    expect(ctx.calls).toEqual(["stopAccepting", "closeAllConnections"]);
    request.release();
    ctx.clock.advance(SHUTDOWN_GRACE_MS);
    await turn();
    expect(ctx.exit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("I3/I4: a hook that hangs exits 1 at the deadline and names the hook", async () => {
    const calls: string[] = [];
    const hang: ShutdownHook = { name: "databases", run: () => new Promise<void>(() => undefined) };
    const ctx = setup([recording(calls, "logs"), hang, recording(calls, "after")]);
    ctx.target.emit("SIGTERM");
    await turn();
    expect(calls).toEqual(["logs"]);
    expect(ctx.exit).not.toHaveBeenCalled();
    ctx.clock.advance(SHUTDOWN_GRACE_MS);
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(ctx.log.mock.calls).toEqual([
      ["shutdown.deadline", { phase: "hooks", hook: "databases", requests: 0 }],
    ]);
    await turn();
    expect(calls).toEqual(["logs"]);
  });

  it("I3/I8: a hook that throws exits 1 after the next hook, logging only names", async () => {
    const calls: string[] = [];
    const secret = "invented-token-0b7e";
    const bad: ShutdownHook = {
      name: "logs",
      run: () => Promise.reject(new TypeError(secret)),
    };
    const ctx = setup([bad, recording(calls, "databases")]);
    ctx.target.emit("SIGINT");
    await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalled());
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(calls).toEqual(["databases"]);
    expect(ctx.log.mock.calls).toEqual([
      ["shutdown.hook_failed", { hook: "logs", error: "TypeError" }],
    ]);
    expect(JSON.stringify(ctx.log.mock.calls)).not.toContain(secret);
    expect(ctx.clock.pending()).toBe(0);
  });

  it("I3: a hook that throws synchronously, or throws a non-error, is the same failure", async () => {
    const ctx = setup([
      {
        name: "logs",
        run: () => {
          throw "invented-string-throw";
        },
      },
    ]);
    ctx.target.emit("SIGTERM");
    await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalled());
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(ctx.log.mock.calls).toEqual([
      ["shutdown.hook_failed", { hook: "logs", error: "string" }],
    ]);
  });

  it("I4: a hook that finishes after the deadline does not exit again", async () => {
    let finish!: () => void;
    const late: ShutdownHook = { name: "databases", run: () => new Promise((r) => (finish = r)) };
    const ctx = setup([late]);
    ctx.target.emit("SIGTERM");
    await turn();
    ctx.clock.advance(SHUTDOWN_GRACE_MS);
    finish();
    await turn();
    expect(ctx.exit.mock.calls).toEqual([[1]]);
  });

  // Codex review on 0be127e: a hook that blocks the event loop past the
  // deadline returns before the overdue timer runs; that is still a deadline.
  it("I3/I4: a hook that blocks the event loop past the deadline exits 1, not 0", async () => {
    const calls: string[] = [];
    let ctx!: ReturnType<typeof setup>;
    const blocking: ShutdownHook = {
      name: "logs",
      run: () => ctx.clock.block(SHUTDOWN_GRACE_MS + 1),
    };
    ctx = setup([blocking, recording(calls, "databases")]);
    ctx.target.emit("SIGTERM");
    await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalled());
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(ctx.log.mock.calls).toEqual([
      ["shutdown.deadline", { phase: "hooks", hook: "logs", requests: 0 }],
    ]);
    expect(calls).toEqual([]);
  });

  it("I3: a request released after the event loop was blocked past the deadline exits 1", async () => {
    const calls: string[] = [];
    const ctx = setup([recording(calls, "logs")]);
    const request = ctx.coordinator.begin()!;
    ctx.target.emit("SIGTERM");
    ctx.clock.block(SHUTDOWN_GRACE_MS);
    request.release();
    await vi.waitFor(() => expect(ctx.exit).toHaveBeenCalled());
    expect(ctx.exit.mock.calls).toEqual([[1]]);
    expect(ctx.log.mock.calls).toEqual([["shutdown.deadline", { phase: "requests", requests: 0 }]]);
    expect(calls).toEqual([]);
  });

  it("nothing happens before a signal", async () => {
    const calls: string[] = [];
    const ctx = setup([recording(calls, "logs")]);
    ctx.clock.advance(SHUTDOWN_GRACE_MS * 2);
    await turn();
    expect(ctx.exit).not.toHaveBeenCalled();
    expect(ctx.listener.stopAccepting).not.toHaveBeenCalled();
    expect(ctx.coordinator.state()).toBe("running");
  });
});

// Codex review on 0be127e: a failed write while flushing is a failed hook.
describe("FLUSH_LOGS", () => {
  it("resolves once stdout and stderr took every line", async () => {
    await expect(FLUSH_LOGS.run()).resolves.toBeUndefined();
  });

  it.each(["stdout", "stderr"] as const)("rejects when a write to %s fails", async (name) => {
    const failure = Object.assign(new Error("invented"), { code: "EPIPE" });
    vi.spyOn(process[name], "write").mockImplementation(((
      _chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.(failure);
      return false;
    }) as typeof process.stdout.write);
    await expect(FLUSH_LOGS.run()).rejects.toBe(failure);
  });
});
