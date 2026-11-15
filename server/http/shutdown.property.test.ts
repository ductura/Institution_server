import { EventEmitter } from "node:events";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type Clock,
  createShutdownCoordinator,
  installShutdown,
  type ShutdownHook,
  type StopResult,
  type Ticket,
} from "./shutdown.ts";

// S-1B-c (DAN-778). Two checks against one plain model:
// - the validator of the whole input: every sequence of up to MAX_STEPS events
//   over the alphabet below, for every hook behaviour, is enumerated (none is
//   sampled) and compared with the model after every step;
// - the Ductus model (d52a92c3, DAN-587) for the coordinator alone, by
//   fast-check over longer sequences.
const GRACE = 100;
const MAX_STEPS = 6;

type Event = "begin" | "release" | "SIGTERM" | "SIGINT" | "tick";
type HookMode = "ok" | "throw" | "hang";
const EVENTS: readonly Event[] = ["begin", "release", "SIGTERM", "SIGINT", "tick"];
const MODES: readonly HookMode[] = ["ok", "throw", "hang"];
const TICK = GRACE / 2;

function manualClock(): Clock & { advance(ms: number): void } {
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
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function* sequences(length: number): Generator<Event[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const head of sequences(length - 1)) for (const e of EVENTS) yield [...head, e];
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

type Model = {
  open: number;
  signalled: boolean;
  elapsed: number;
  drainedAt: number | undefined;
  exit: number[];
  hooks: string[];
};

/** What the model says after the events so far, for one hook behaviour. */
function advanceModel(model: Model, event: Event, mode: HookMode): void {
  if (event === "begin" && !model.signalled) model.open += 1;
  if (event === "release" && model.open > 0) model.open -= 1;
  if ((event === "SIGTERM" || event === "SIGINT") && !model.signalled) model.signalled = true;
  else if (event === "tick" && model.signalled) model.elapsed += TICK;
  if (!model.signalled || model.exit.length > 0) return;
  if (model.drainedAt === undefined && model.open === 0) {
    model.drainedAt = model.elapsed;
    model.hooks.push("logs", "databases");
    if (mode === "ok") model.exit.push(0);
    if (mode === "throw") model.exit.push(1);
  }
  if (model.exit.length === 0 && model.elapsed >= GRACE) model.exit.push(1);
}

async function check(events: readonly Event[], mode: HookMode): Promise<void> {
  const clock = manualClock();
  const coordinator = createShutdownCoordinator({ clock, graceMs: GRACE });
  const target = new EventEmitter();
  const exit: number[] = [];
  const hooks: string[] = [];
  const logs: string[] = [];
  const hook: ShutdownHook = {
    name: "databases",
    run: () => {
      hooks.push("databases");
      if (mode === "throw") throw new Error("invented");
      if (mode === "hang") return new Promise<void>(() => undefined);
      return undefined;
    },
  };
  let accepting = true;
  installShutdown(target, {
    coordinator,
    listener: { stopAccepting: () => (accepting = false), closeAllConnections: () => undefined },
    hooks: [{ name: "logs", run: () => void hooks.push("logs") }, hook],
    exit: (code) => exit.push(code),
    clock,
    log: (event) => logs.push(event),
  });
  const tickets: Ticket[] = [];
  const model: Model = {
    open: 0,
    signalled: false,
    elapsed: 0,
    drainedAt: undefined,
    exit: [],
    hooks: [],
  };

  for (const event of events) {
    if (event === "begin") {
      const ticket = coordinator.begin();
      expect(ticket === null).toBe(model.signalled);
      if (ticket) tickets.push(ticket);
    } else if (event === "release") {
      tickets.shift()?.release();
    } else if (event === "tick") {
      clock.advance(TICK);
    } else {
      target.emit(event);
    }
    advanceModel(model, event, mode);
    await flush();

    expect(coordinator.active()).toBe(model.open);
    expect(accepting).toBe(!model.signalled);
    expect(exit).toEqual(model.exit);
    expect(hooks).toEqual(model.hooks);
    expect(logs.length).toBe(exit[0] === 1 ? 1 : 0);
  }
}

describe("shutdown: every sequence of events, every hook behaviour", () => {
  it(`matches the model for all ${MAX_STEPS}-step sequences`, async () => {
    let count = 0;
    for (const mode of MODES) {
      for (let length = 0; length <= MAX_STEPS; length += 1) {
        for (const events of sequences(length)) {
          try {
            await check(events, mode);
          } catch (error) {
            throw new Error(`${mode}: ${events.join(" ")}`, { cause: error });
          }
          count += 1;
        }
      }
    }
    // 3 modes × (5^0 + … + 5^6): nothing sampled, nothing left out.
    expect(count).toBe(3 * ((5 ** (MAX_STEPS + 1) - 1) / 4));
  }, 120_000);
});

type Step =
  { op: "begin" } | { op: "release"; index: number } | { op: "stop" } | { op: "tick"; ms: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ op: fc.constant("begin" as const) }),
  fc.record({ op: fc.constant("release" as const), index: fc.nat(20) }),
  fc.record({ op: fc.constant("stop" as const) }),
  fc.record({ op: fc.constant("tick" as const), ms: fc.integer({ min: 1, max: 60 }) }),
);

describe("shutdown coordinator model", () => {
  it("matches the model for any sequence of begin, release, stop and tick", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 60 }), async (steps) => {
        const clock = manualClock();
        const shutdown = createShutdownCoordinator({ clock, graceMs: GRACE });
        const tickets: Array<{ ticket: Ticket; released: boolean }> = [];
        let stopped = false;
        let elapsedSinceStop = 0;
        let result: StopResult | undefined;
        let expected: StopResult | undefined;
        let stopping: Promise<StopResult> | undefined;

        const open = () => tickets.filter((t) => !t.released).length;
        const decide = () => {
          if (!stopped || expected) return;
          if (open() === 0) expected = { outcome: "drained" };
          else if (elapsedSinceStop >= GRACE)
            expected = { outcome: "deadline", unfinished: open() };
        };

        for (const s of steps) {
          if (s.op === "begin") {
            const ticket = shutdown.begin();
            if (stopped) expect(ticket).toBeNull();
            else {
              expect(ticket).not.toBeNull();
              tickets.push({ ticket: ticket!, released: false });
            }
          } else if (s.op === "release") {
            const entry = tickets[s.index % Math.max(tickets.length, 1)];
            if (entry) {
              entry.ticket.release();
              entry.released = true;
            }
          } else if (s.op === "stop") {
            const next = shutdown.stop();
            if (stopping) expect(next).toBe(stopping);
            stopping = next;
            void next.then((r) => (result = r));
            stopped = true;
          } else {
            clock.advance(s.ms);
            if (stopped) elapsedSinceStop += s.ms;
          }
          decide();
          await Promise.resolve();
          await Promise.resolve();

          expect(shutdown.active()).toBe(open());
          expect(result).toEqual(expected);
          expect(shutdown.state()).toBe(!stopped ? "running" : expected ? "stopped" : "draining");
        }
      }),
    );
  });
});
