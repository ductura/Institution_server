// S-1E-c (DAN-837): one pattern for every outside service. Invented values only.
import { createFakeClock } from "@ductura/test-fakes/clock";
import { describe, expect, it, vi } from "vitest";

import { createExternalCaller, type ExternalCallEvent } from "./external-call.ts";

const POLICY = { timeoutMs: 1000, retries: 2, retryDelayMs: 100, downAfter: 2, downForMs: 5000 };

function setup(policy = POLICY) {
  const clock = createFakeClock();
  const events: ExternalCallEvent[] = [];
  const caller = createExternalCaller("email", policy, {
    now: () => clock.nowMs(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    onEvent: (event) => events.push(event),
  });
  return { clock, events, caller };
}

// Microtasks, then one macrotask: the expiry yields one macrotask before it
// calls a timeout, so work that finished by the deadline is heard first.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

describe("createExternalCaller", () => {
  it("answers ok and reports one closed event", async () => {
    const { events, caller } = setup();
    expect(await caller.call("send", async () => "done")).toEqual({ ok: true, value: "done" });
    expect(events).toEqual([
      {
        event: "external_call",
        service: "email",
        operation: "send",
        outcome: "ok",
        attempts: 1,
        durationMs: 0,
      },
    ]);
  });

  it("ends a slow call at the deadline and aborts it", async () => {
    const { clock, events, caller } = setup();
    let signal: AbortSignal | undefined;
    const pending = caller.call("send", (s) => ((signal = s), new Promise<string>(() => {})));
    await flush();
    clock.advance(999);
    await flush();
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await pending).toEqual({ ok: false, failure: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 1, durationMs: 1000 });
  });

  it("retries only when asked, and never past the deadline", async () => {
    const { clock, events, caller } = setup();
    let once = 0;
    const once1 = await caller.call("send", async () => {
      once += 1;
      throw new Error("connect ECONNREFUSED");
    });
    expect(once1).toEqual({ ok: false, failure: "failed" });
    expect(once).toBe(1);

    const { clock: c2, caller: c2caller, events: e2 } = setup({ ...POLICY, downAfter: 9 });
    let attempts = 0;
    const retried = c2caller.call(
      "read",
      async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("fetch failed");
        return "bytes";
      },
      { retry: true },
    );
    await flush();
    c2.advance(100);
    await flush();
    c2.advance(100);
    expect(await retried).toEqual({ ok: true, value: "bytes" });
    expect(e2[0]).toMatchObject({ outcome: "ok", attempts: 3, durationMs: 200 });

    const slowRetry = setup({ ...POLICY, retryDelayMs: 900, downAfter: 9 });
    let tries = 0;
    const late = slowRetry.caller.call(
      "read",
      async () => {
        tries += 1;
        throw new TypeError("fetch failed");
      },
      { retry: true },
    );
    await flush();
    slowRetry.clock.advance(900);
    expect(await late).toEqual({ ok: false, failure: "failed" });
    expect(tries).toBe(2);
    expect(slowRetry.clock.nowMs() - createFakeClock().nowMs()).toBe(900);
    expect(events).toHaveLength(1);
    expect(clock.nowMs()).toBe(createFakeClock().nowMs());
  });

  it("treats an answer the service marks as failed like a throw", async () => {
    const { caller } = setup();
    const result = await caller.call("send", async () => "refused", {
      failed: (v) => v === "refused",
    });
    expect(result).toEqual({ ok: false, failure: "failed", answer: "refused" });
  });

  it("survives a service that throws synchronously or rejects with a non-Error", async () => {
    const { caller } = setup({ ...POLICY, downAfter: 9 });
    const sync = await caller.call("send", () => {
      throw "plain string";
    });
    expect(sync).toEqual({ ok: false, failure: "failed" });
    const odd = await caller.call("send", () => Promise.reject(Object.create(null)));
    expect(odd).toEqual({ ok: false, failure: "failed" });
  });

  it("marks the service down after repeated failures and skips it until the window ends", async () => {
    const { clock, events, caller } = setup();
    let reached = 0;
    const fail = async (): Promise<string> => {
      reached += 1;
      throw new Error("down");
    };
    await caller.call("send", fail);
    expect(caller.availability()).toBe("available");
    await caller.call("send", fail);
    expect(caller.availability()).toBe("down");
    expect(await caller.call("send", fail)).toEqual({ ok: false, failure: "down" });
    expect(reached).toBe(2);
    expect(events.at(-1)).toMatchObject({ outcome: "down", attempts: 0 });
    clock.advance(5000);
    expect(caller.availability()).toBe("available");
    expect(await caller.call("send", async () => "ok")).toEqual({ ok: true, value: "ok" });
    expect(caller.availability()).toBe("available");
  });

  it("never puts a secret, an address or an error message into the event", async () => {
    const { events, caller } = setup({ ...POLICY, downAfter: 9 });
    const CANARY = "canary-secret-a1b2@primjer.invalid";
    await caller.call("send", async () => {
      throw new Error(CANARY, { cause: CANARY });
    });
    await caller.call("send", async () => CANARY);
    expect(JSON.stringify(events)).not.toContain("canary");
    for (const event of events)
      expect(Object.keys(event).sort()).toEqual([
        "attempts",
        "durationMs",
        "event",
        "operation",
        "outcome",
        "service",
      ]);
  });

  it("counts a failed-check that throws as a failure, not a timeout", async () => {
    const { caller } = setup();
    const result = await caller.call("send", async () => 1, {
      failed: () => {
        throw new Error("check");
      },
    });
    expect(result).toEqual({ ok: false, failure: "failed" });
  });

  it("consumes the rejection of an async event sink (Codex c.4585087003)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const caller = createExternalCaller("email", POLICY, {
        onEvent: async () => {
          throw new Error("event-sink-offline");
        },
      });
      expect(await caller.call("send", async () => 1)).toEqual({ ok: true, value: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // DAN-837-1 (c.6916193722, plan #149 E-3): synchronous work in an adapter
  // cannot be interrupted. The call reports the real duration, which may be
  // longer than the deadline, and the outcome `timeout`; no value comes back.
  describe("synchronous work past the deadline is measured, not cut", () => {
    const SHORT = { ...POLICY, timeoutMs: 10, downAfter: 9 };
    const overrun = (then: () => Promise<string>, clock: { advance(ms: number): void }) => () => {
      clock.advance(40); // 40 ms of synchronous work against a 10 ms deadline
      return then();
    };

    it.each([
      ["returns a value", () => Promise.resolve("late")],
      ["returns a promise that never settles", () => new Promise<string>(() => {})],
      ["rejects", () => Promise.reject(new TypeError("fetch failed"))],
      [
        "throws",
        (): Promise<string> => {
          throw new TypeError("fetch failed");
        },
      ],
    ])("the adapter %s: timeout with the real duration", async (_name, then) => {
      const { clock, events, caller } = setup(SHORT);
      const result = await caller.call("read", overrun(then, clock), { retry: true });
      expect(result).toEqual({ ok: false, failure: "timeout" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 1, durationMs: 40 });
      expect(events[0]?.durationMs).toBeGreaterThan(SHORT.timeoutMs);
    });

    it("also when no timer ever fires", async () => {
      let time = 0;
      const events: ExternalCallEvent[] = [];
      const caller = createExternalCaller("storage", SHORT, {
        now: () => time,
        sleep: () => new Promise(() => {}),
        onEvent: (e) => events.push(e),
      });
      const result = await caller.call("read", async () => {
        time += 40;
        return "late";
      });
      expect(result).toEqual({ ok: false, failure: "timeout" });
      expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 1, durationMs: 40 });
      expect(events[0]?.durationMs).toBeGreaterThan(SHORT.timeoutMs);
    });

    // Orchestrator c.6917535971 (review c.6917395187, QA c.6917413624): the
    // outcome follows the time the attempt ended, not who wins the race. An
    // answer at the deadline counts (`now() - start <= timeoutMs`), with a
    // live timer or none; one millisecond later is a timeout.
    type Ending = (advance: (ms: number) => void) => Promise<string>;
    const endings: [string, Ending, unknown, number][] = [
      [
        "a value exactly at the deadline",
        async (a) => (a(10), "bytes"),
        { ok: true, value: "bytes" },
        10,
      ],
      [
        "a rejection exactly at the deadline",
        async (a) => {
          a(10);
          throw new TypeError("fetch failed");
        },
        { ok: false, failure: "failed" },
        10,
      ],
      [
        "a value at the deadline after a chain of microtasks",
        async (a) => {
          a(10);
          for (let i = 0; i < 5; i += 1) await null;
          return "bytes";
        },
        { ok: true, value: "bytes" },
        10,
      ],
      [
        "a value 1 ms after the deadline",
        async (a) => (a(11), "bytes"),
        { ok: false, failure: "timeout" },
        11,
      ],
      [
        "a rejection 1 ms after the deadline",
        async (a) => {
          a(11);
          throw new TypeError("fetch failed");
        },
        { ok: false, failure: "timeout" },
        11,
      ],
    ];

    it.each(endings)("live timer: %s", async (_name, run, expected, duration) => {
      const { clock, events, caller } = setup(SHORT);
      expect(await caller.call("read", () => run((ms) => clock.advance(ms)))).toEqual(expected);
      expect(events[0]).toMatchObject({ attempts: 1, durationMs: duration });
    });

    it.each(endings)("no timer: %s", async (_name, run, expected) => {
      let time = 0;
      const caller = createExternalCaller("storage", SHORT, {
        now: () => time,
        sleep: () => new Promise(() => {}),
      });
      expect(await caller.call("read", () => run((ms) => (time += ms)))).toEqual(expected);
    });

    it("a failed-check that ends exactly at the deadline keeps its verdict", async () => {
      const { clock, caller } = setup(SHORT);
      expect(
        await caller.call("read", async () => "bytes", {
          failed: () => (clock.advance(10), false),
        }),
      ).toEqual({ ok: true, value: "bytes" });
      const thrown = setup(SHORT);
      expect(
        await thrown.caller.call("read", async () => "bytes", {
          failed: () => {
            thrown.clock.advance(10);
            throw new Error("check broke");
          },
        }),
      ).toEqual({ ok: false, failure: "failed" });
    });

    it("an attempt starts only while time is left: a pause that ends at the deadline starts none", async () => {
      const { clock, caller } = setup({ ...SHORT, retryDelayMs: 10 });
      let tries = 0;
      const result = caller.call(
        "read",
        async (): Promise<string> => {
          tries += 1;
          throw new TypeError("fetch failed");
        },
        { retry: true },
      );
      await flush();
      clock.advance(10);
      expect(await result).toEqual({ ok: false, failure: "failed" });
      expect(tries).toBe(1);
    });

    it("an adapter that never answers still ends at the deadline", async () => {
      const { clock, events, caller } = setup(SHORT);
      const pending = caller.call("read", () => new Promise<string>(() => {}));
      let done = false;
      void pending.then(() => (done = true));
      clock.advance(9);
      await flush();
      expect(done).toBe(false);
      clock.advance(1);
      await flush();
      expect(done).toBe(true);
      expect(await pending).toEqual({ ok: false, failure: "timeout" });
      expect(events[0]).toMatchObject({ durationMs: 10 });
    });
  });

  it("starts no retry at or after the deadline (Codex c.4585086980)", async () => {
    let time = 0;
    let tries = 0;
    const caller = createExternalCaller(
      "storage",
      { ...POLICY, retryDelayMs: 100, downAfter: 9 },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms === 100 ? 2000 : 0; // the pause overruns the whole deadline
        },
      },
    );
    const result = await caller.call(
      "read",
      async () => {
        tries += 1;
        throw new TypeError("fetch failed");
      },
      { retry: true },
    );
    expect(result).toEqual({ ok: false, failure: "timeout" });
    expect(tries).toBe(1);
  });

  it("lets one probe through after the down window, alone and without retry (Codex c.4585086991)", async () => {
    const { clock, caller } = setup({ ...POLICY, retries: 2, downAfter: 1, downForMs: 5000 });
    let reached = 0;
    const fail = async (): Promise<string> => {
      reached += 1;
      throw new Error("down");
    };
    await caller.call("read", fail);
    expect(caller.availability()).toBe("down");
    clock.advance(5000);
    expect(caller.availability()).toBe("available");
    reached = 0;

    let release: (v: string) => void = () => {};
    const probe = caller.call(
      "read",
      () => ((reached += 1), new Promise<string>((r) => (release = r))),
      {
        retry: true,
      },
    );
    await flush();
    expect(caller.availability()).toBe("down");
    expect(await caller.call("read", fail, { retry: true })).toEqual({
      ok: false,
      failure: "down",
    });
    expect(reached).toBe(1);
    release("ok");
    expect(await probe).toEqual({ ok: true, value: "ok" });
    expect(caller.availability()).toBe("available");

    await caller.call("read", fail);
    clock.advance(5000);
    reached = 0;
    expect(await caller.call("read", fail, { retry: true })).toEqual({
      ok: false,
      failure: "failed",
    });
    expect(reached).toBe(1);
    expect(caller.availability()).toBe("down");
  });

  it("counts synchronous work inside the service against the deadline (QA c.6915174918, 1)", async () => {
    const { clock, events, caller } = setup();
    const pending = caller.call("send", () => {
      clock.advance(200); // 200 ms of synchronous work before a promise that never settles
      return new Promise<string>(() => {});
    });
    await flush();
    clock.advance(800);
    expect(await pending).toEqual({ ok: false, failure: "timeout" });
    expect(events[0]).toMatchObject({ outcome: "timeout", durationMs: 1000 });
  });

  it("keeps the down window when a call that started earlier succeeds, then lets one probe through (QA c.6915174918, 2)", async () => {
    const { clock, caller } = setup({ ...POLICY, downAfter: 1, downForMs: 5000 });
    let reached = 0;
    const fail = async (): Promise<string> => {
      reached += 1;
      throw new Error("down");
    };
    let release: (v: string) => void = () => {};
    const earlier = caller.call("read", () => new Promise<string>((r) => (release = r)));
    await flush();
    await caller.call("read", fail);
    expect(caller.availability()).toBe("down");
    release("ok");
    expect(await earlier).toEqual({ ok: true, value: "ok" });
    // The earlier call started before the window: it reports, but the window stays.
    expect(caller.availability()).toBe("down");

    reached = 0;
    expect(await caller.call("read", fail)).toEqual({ ok: false, failure: "down" });
    expect(reached).toBe(0);
    clock.advance(5000);
    reached = 0;
    expect(await caller.call("read", fail, { retry: true })).toEqual({
      ok: false,
      failure: "failed",
    });
    expect(reached).toBe(1);
  });

  // Review and QA FAIL on ddba14b4, finding 1: the deadline counts from the
  // start of the call, whatever caller code runs before the timer would fire.
  describe("the deadline counts from the start of the call", () => {
    const settled = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(() => (state.done = true));
      return state;
    };

    it("when the service works synchronously before it yields", async () => {
      const { clock, events, caller } = setup();
      const pending = caller.call("send", () => {
        clock.advance(600); // synchronous preparation inside the adapter
        return new Promise<string>(() => {});
      });
      const state = settled(pending);
      await flush();
      clock.advance(399);
      await flush();
      expect(state.done).toBe(false);
      clock.advance(1);
      await flush();
      expect(state.done).toBe(true);
      expect(await pending).toEqual({ ok: false, failure: "timeout" });
      expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 1, durationMs: 1000 });
    });

    it("when a retry works synchronously before it yields", async () => {
      const { clock, events, caller } = setup({ ...POLICY, downAfter: 9 });
      let tries = 0;
      const pending = caller.call(
        "read",
        () => {
          tries += 1;
          if (tries === 1) return Promise.reject(new TypeError("fetch failed"));
          clock.advance(500);
          return new Promise<string>(() => {});
        },
        { retry: true },
      );
      const state = settled(pending);
      await flush();
      clock.advance(100); // the pause, then the second try spends 500 ms
      await flush();
      expect(tries).toBe(2);
      clock.advance(399);
      await flush();
      expect(state.done).toBe(false);
      clock.advance(1);
      await flush();
      expect(state.done).toBe(true);
      expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 2, durationMs: 1000 });
    });

    it("when the failed-check spends the rest of the deadline, whatever the timers did", async () => {
      let time = 0;
      const caller = createExternalCaller("storage", POLICY, {
        now: () => time,
        sleep: () => new Promise(() => {}), // no timer ever fires
      });
      const result = await caller.call("read", async () => "bytes", {
        failed: () => ((time += 1500), false),
      });
      expect(result).toEqual({ ok: false, failure: "timeout" });
      const thrown = await caller.call("read", async () => "bytes", {
        failed: () => {
          time += 1500;
          throw new Error("check broke");
        },
      });
      expect(thrown).toEqual({ ok: false, failure: "timeout" });
    });
  });

  // Review and QA FAIL on ddba14b4, finding 2: a call that started before the
  // availability changed must not change it when it ends.
  describe("a call that started before a change of availability leaves it alone", () => {
    const LONG = { ...POLICY, timeoutMs: 60_000, retries: 2, downAfter: 1, downForMs: 5000 };
    const parked = () => {
      const hold: { ok: (v: string) => void; fail: (e: Error) => void } = {
        ok: () => {},
        fail: () => {},
      };
      const run = () =>
        new Promise<string>((resolve, reject) => ((hold.ok = resolve), (hold.fail = reject)));
      return { hold, run };
    };

    it("an earlier success does not cancel the single probe", async () => {
      const { clock, events, caller } = setup(LONG);
      const a = parked();
      const pendingA = caller.call("read", a.run, { retry: true });
      await flush();
      await caller.call("read", async () => {
        throw new TypeError("fetch failed");
      });
      expect(caller.availability()).toBe("down");
      a.hold.ok("late");
      expect(await pendingA).toEqual({ ok: true, value: "late" });
      expect(caller.availability()).toBe("down");

      clock.advance(5000);
      let reached = 0;
      const fail = async (): Promise<string> => {
        reached += 1;
        throw new TypeError("fetch failed");
      };
      const probe = caller.call("read", fail, { retry: true });
      const other = caller.call("read", fail, { retry: true });
      await flush();
      expect(reached).toBe(1);
      expect(await other).toEqual({ ok: false, failure: "down" });
      expect(await probe).toEqual({ ok: false, failure: "failed" });
      expect(reached).toBe(1);
      expect(events.at(-2)).toMatchObject({ outcome: "down", attempts: 0 });
      expect(events.at(-1)).toMatchObject({ outcome: "failed", attempts: 1 });
      expect(caller.availability()).toBe("down");
    });

    it("an earlier answer during the probe neither opens nor closes the service", async () => {
      const { clock, caller } = setup(LONG);
      const a1 = parked();
      const a2 = parked();
      const pending1 = caller.call("read", a1.run);
      const pending2 = caller.call("read", a2.run);
      await caller.call("read", async () => {
        throw new TypeError("fetch failed");
      });
      clock.advance(5000);

      const probe = parked();
      const pendingProbe = caller.call("read", probe.run);
      await flush();
      a1.hold.ok("late");
      expect(await pending1).toEqual({ ok: true, value: "late" });
      expect(caller.availability()).toBe("down");
      expect(await caller.call("read", async () => "x")).toEqual({ ok: false, failure: "down" });

      probe.hold.ok("back");
      expect(await pendingProbe).toEqual({ ok: true, value: "back" });
      expect(caller.availability()).toBe("available");
      a2.hold.fail(new TypeError("fetch failed"));
      expect(await pending2).toEqual({ ok: false, failure: "failed" });
      expect(caller.availability()).toBe("available");
      expect(await caller.call("read", async () => "x")).toEqual({ ok: true, value: "x" });
    });

    it("an earlier failure after the down window does not open it again", async () => {
      const { clock, caller } = setup({ ...LONG, downAfter: 2 });
      const a = parked();
      const pendingA = caller.call("read", a.run);
      const failNow = async (): Promise<string> => {
        throw new TypeError("fetch failed");
      };
      await caller.call("read", failNow);
      await caller.call("read", failNow);
      clock.advance(5000);
      expect(await caller.call("read", async () => "back")).toEqual({ ok: true, value: "back" });
      a.hold.fail(new TypeError("fetch failed"));
      await pendingA;
      await caller.call("read", failNow);
      // one fresh failure is below downAfter = 2; the stale one does not count
      expect(caller.availability()).toBe("available");
    });
  });

  // QA FAIL on 002ed3e0 (c.6915658985): availability is asked again before
  // every retry, so a parallel call over the same caller that opened the
  // breaker meanwhile stops the retry from reaching the service.
  describe("a retry asks again whether the service is down", () => {
    const QA = { ...POLICY, timeoutMs: 60_000, retries: 2, downAfter: 1, downForMs: 5000 };
    const counted = () => {
      const reached = { read: 0, put: 0 };
      const failing = (op: "read" | "put") => async (): Promise<string> => {
        reached[op] += 1;
        throw new TypeError("fetch failed");
      };
      return { reached, read: failing("read"), put: failing("put") };
    };

    it("a parallel failure opens the breaker during the pause: the retry does not go (QA c.6915658985)", async () => {
      const { clock, events, caller } = setup({ ...QA, retryDelayMs: 100 });
      const svc = counted();
      const read = caller.call("read", svc.read, { retry: true });
      await flush();
      expect(svc.reached.read).toBe(1);
      expect(await caller.call("put", svc.put)).toEqual({ ok: false, failure: "failed" });
      expect(caller.availability()).toBe("down");

      clock.advance(100);
      expect(await read).toEqual({ ok: false, failure: "down" });
      expect(svc.reached.read).toBe(1);
      expect(events.at(-1)).toMatchObject({ operation: "read", outcome: "down", attempts: 1 });
      // The stale call only reports: the window is the one the put opened.
      expect(caller.availability()).toBe("down");
      clock.advance(4899);
      expect(caller.availability()).toBe("down");
      clock.advance(1);
      expect(caller.availability()).toBe("available");
    });

    it("the breaker opens before the pause: the call ends at once as down", async () => {
      const { events, caller } = setup({ ...QA, retryDelayMs: 100 });
      let release: (e: Error) => void = () => {};
      let reached = 0;
      const read = caller.call(
        "read",
        () => ((reached += 1), new Promise<string>((_, reject) => (release = reject))),
        { retry: true },
      );
      await flush();
      await caller.call("put", async () => {
        throw new TypeError("fetch failed");
      });
      release(new TypeError("fetch failed"));
      expect(await read).toEqual({ ok: false, failure: "down" });
      expect(reached).toBe(1);
      expect(events.at(-1)).toMatchObject({ outcome: "down", attempts: 1, durationMs: 0 });
    });

    it("the window ended but no probe ran yet: the retry does not become one", async () => {
      const { clock, caller } = setup({ ...QA, retryDelayMs: 6000 });
      const svc = counted();
      const read = caller.call("read", svc.read, { retry: true });
      await flush();
      await caller.call("put", svc.put);
      clock.advance(6000);
      expect(await read).toEqual({ ok: false, failure: "down" });
      expect(svc.reached.read).toBe(1);
      // The next fresh call is the single probe, alone and without retry.
      expect(await caller.call("read", svc.read, { retry: true })).toEqual({
        ok: false,
        failure: "failed",
      });
      expect(svc.reached.read).toBe(2);
    });

    it("another call is the probe: the retry does not go", async () => {
      const { clock, caller } = setup({ ...QA, retryDelayMs: 6000 });
      const svc = counted();
      const read = caller.call("read", svc.read, { retry: true });
      await flush();
      await caller.call("put", svc.put);
      clock.advance(5000);
      let release: (v: string) => void = () => {};
      const probe = caller.call("head", () => new Promise<string>((r) => (release = r)));
      await flush();
      expect(caller.availability()).toBe("down");
      clock.advance(1000);
      expect(await read).toEqual({ ok: false, failure: "down" });
      expect(svc.reached.read).toBe(1);
      release("back");
      expect(await probe).toEqual({ ok: true, value: "back" });
      expect(caller.availability()).toBe("available");
    });

    it("every retry asks, not only the first", async () => {
      const { clock, caller } = setup({ ...QA, retryDelayMs: 100 });
      const svc = counted();
      const read = caller.call("read", svc.read, { retry: true });
      await flush();
      clock.advance(100);
      await flush();
      expect(svc.reached.read).toBe(2);
      await caller.call("put", svc.put);
      clock.advance(100);
      expect(await read).toEqual({ ok: false, failure: "down" });
      expect(svc.reached.read).toBe(2);
    });

    it("the probe closed the breaker again during the pause: the retry goes", async () => {
      const { clock, caller } = setup({ ...QA, retryDelayMs: 6000 });
      let reached = 0;
      const read = caller.call(
        "read",
        async () => {
          reached += 1;
          if (reached === 1) throw new TypeError("fetch failed");
          return "back";
        },
        { retry: true },
      );
      await flush();
      await caller.call("put", async () => {
        throw new TypeError("fetch failed");
      });
      clock.advance(5000);
      expect(await caller.call("head", async () => "probe")).toEqual({ ok: true, value: "probe" });
      clock.advance(1000);
      expect(await read).toEqual({ ok: true, value: "back" });
      expect(reached).toBe(2);
      expect(caller.availability()).toBe("available");
    });
  });

  it("survives an event sink that throws", async () => {
    const caller = createExternalCaller("keys", POLICY, {
      onEvent: () => {
        throw new Error("sink");
      },
    });
    expect(await caller.call("sign", async () => 1)).toEqual({ ok: true, value: 1 });
  });

  // Plan #149, input classes: each one is refused before the service is reached.
  describe("input classes", () => {
    const TIMER_MAX = 2 ** 31 - 1;
    const inherited = Object.create(POLICY) as typeof POLICY;
    const policies: [string, unknown][] = [
      ["null", null],
      ["an array", [1000, 2, 100, 2, 5000]],
      ["a string", "timeoutMs=1000"],
      ["a missing key", { timeoutMs: 1000, retries: 2, retryDelayMs: 100, downAfter: 2 }],
      ["keys inherited from the prototype", inherited],
      ["an unknown key (additionalProperties)", { ...POLICY, retry: true }],
      ["__proto__ as an own key", JSON.parse(`{"__proto__":{},${JSON.stringify(POLICY).slice(1)}`)],
      ["timeoutMs = NaN", { ...POLICY, timeoutMs: Number.NaN }],
      ["timeoutMs = 0", { ...POLICY, timeoutMs: 0 }],
      ["timeoutMs = 1.5", { ...POLICY, timeoutMs: 1.5 }],
      ["timeoutMs as a string", { ...POLICY, timeoutMs: "1000" }],
      ["timeoutMs as a Number object", { ...POLICY, timeoutMs: Object(1000) }],
      ["timeoutMs as a bigint", { ...POLICY, timeoutMs: 1000n }],
      ["timeoutMs above the timer limit", { ...POLICY, timeoutMs: TIMER_MAX + 1 }],
      ["retryDelayMs above the timer limit", { ...POLICY, retryDelayMs: TIMER_MAX + 1 }],
      ["retryDelayMs = Infinity", { ...POLICY, retryDelayMs: Number.POSITIVE_INFINITY }],
      ["retries = -1", { ...POLICY, retries: -1 }],
      ["downAfter = 0", { ...POLICY, downAfter: 0 }],
      ["downForMs = -5", { ...POLICY, downForMs: -5 }],
    ];

    it.each(policies)("refuses a policy with %s", (_name, policy) => {
      expect(() =>
        createExternalCaller("storage", policy as Parameters<typeof createExternalCaller>[1]),
      ).toThrow(RangeError);
    });

    // QA FAIL c.6916918330: a policy must be a plain record, not only carry
    // five valid own keys. Its prototype is Object.prototype or null, and the
    // caller keeps the values it checked, whatever the object does later.
    class PolicyRecord {
      timeoutMs = 1000;
      retries = 2;
      retryDelayMs = 100;
      downAfter = 2;
      downForMs = 5000;
    }
    it.each([
      ["a prototype with an extra key", Object.assign(Object.create({ extra: true }), POLICY)],
      ["a prototype with no keys", Object.assign(Object.create({}), POLICY)],
      [
        "a prototype without a prototype",
        Object.assign(Object.create(Object.create(null)), POLICY),
      ],
      ["a class instance", new PolicyRecord()],
      ["an array prototype", Object.assign(Object.create(Array.prototype), POLICY)],
    ])("refuses a policy with %s", (_name, policy) => {
      let reached = 0;
      expect(() => {
        const caller = createExternalCaller("storage", policy as typeof POLICY);
        void caller.call("read", async () => (reached += 1));
      }).toThrow(RangeError);
      expect(reached).toBe(0);
    });

    it("keeps the checked values when the policy object changes later", async () => {
      const policy = { ...POLICY };
      const { clock, events, caller } = (() => {
        const clock = createFakeClock();
        const events: ExternalCallEvent[] = [];
        const caller = createExternalCaller("email", policy, {
          now: () => clock.nowMs(),
          sleep: (ms, signal) => clock.sleep(ms, signal),
          onEvent: (event) => events.push(event),
        });
        return { clock, events, caller };
      })();
      policy.timeoutMs = 0;
      policy.downAfter = 0;
      const pending = caller.call("send", () => new Promise<string>(() => {}));
      clock.advance(999);
      await flush();
      expect(events).toHaveLength(0);
      clock.advance(1);
      expect(await pending).toEqual({ ok: false, failure: "timeout" });
      expect(events[0]).toMatchObject({ durationMs: 1000 });
      expect(caller.availability()).toBe("available");
    });

    it("keeps the checked values when a proxy answers differently on a later read", async () => {
      let reads = 0;
      const policy = new Proxy(
        { ...POLICY },
        {
          get: (target, key, receiver) => (
            (reads += 1),
            key === "timeoutMs" ? 0 : Reflect.get(target, key, receiver)
          ),
        },
      );
      const { clock, caller } = setup(policy);
      const pending = caller.call("send", () => new Promise<string>(() => {}));
      clock.advance(999);
      let done = false;
      void pending.then(() => (done = true));
      await flush();
      expect(done).toBe(false);
      clock.advance(1);
      expect(await pending).toEqual({ ok: false, failure: "timeout" });
      expect(reads).toBe(0);
    });

    it("accepts a plain policy, one without a prototype and the timer limit itself", () => {
      const bare = Object.assign(Object.create(null) as object, POLICY) as typeof POLICY;
      for (const policy of [POLICY, bare, { ...POLICY, timeoutMs: TIMER_MAX }])
        expect(createExternalCaller("storage", policy).availability()).toBe("available");
    });

    it.each(["Storage", "sms", "__proto__", "toString", "", 7, null])(
      "refuses the service %j outside the closed list",
      (service) => {
        expect(() =>
          createExternalCaller(service as Parameters<typeof createExternalCaller>[0], POLICY),
        ).toThrow(RangeError);
      },
    );

    const badOperations: unknown[] = [
      "",
      "Send",
      "send mail",
      " send",
      "send ",
      "send\n",
      "send\r\n",
      "send\t",
      "send\u00a0",
      "send\u007f",
      "__proto__",
      "toString",
      "c:\\send",
      "s".repeat(41),
      "šalji",
      7,
      null,
      ["send"],
      { toString: () => "send" },
      Object("send"),
    ];

    it.each(badOperations)("refuses the operation %j before the service", (operation) => {
      const { caller } = setup();
      let reached = 0;
      expect(() =>
        caller.call(operation as string, async () => {
          reached += 1;
          return 1;
        }),
      ).toThrow(RangeError);
      expect(reached).toBe(0);
    });

    it("accepts plain operation codes", async () => {
      const { caller } = setup();
      for (const operation of ["send", "read_immutable", "s".repeat(40)])
        expect(await caller.call(operation, async () => 1)).toEqual({ ok: true, value: 1 });
    });

    it("retries only on an own `retry: true`", async () => {
      for (const options of [
        { retry: "true" as unknown as boolean },
        { retry: 1 as unknown as boolean },
      ]) {
        const { caller } = setup({ ...POLICY, downAfter: 9 });
        let reached = 0;
        const result = await caller.call(
          "read",
          async (): Promise<string> => {
            reached += 1;
            throw new TypeError("fetch failed");
          },
          options,
        );
        expect(result).toEqual({ ok: false, failure: "failed" });
        expect(reached).toBe(1);
      }
    });

    // Orchestrator c.6917060647: the same plain-record rule as the policy.
    class OptionsRecord {
      retry = true;
    }
    it.each([
      ["null", null],
      ["a string", "retry"],
      ["a number", 1],
      ["an array", [true]],
      ["an inherited retry", Object.create({ retry: true })],
      ["a prototype with no keys", Object.assign(Object.create({}), { retry: true })],
      ["a prototype without a prototype", Object.create(Object.create(null))],
      ["a class instance", new OptionsRecord()],
    ])("refuses options that are %s before the service", (_name, options) => {
      const { caller } = setup();
      let reached = 0;
      const run = async () => (reached += 1);
      expect(() => caller.call("read", run, options as unknown as { retry?: boolean })).toThrow(
        RangeError,
      );
      expect(reached).toBe(0);
    });

    it("accepts plain options and options without a prototype", async () => {
      const { caller } = setup();
      const bare = Object.assign(Object.create(null) as object, { failed: (v: number) => v === 1 });
      expect(await caller.call("read", async () => 1, bare)).toEqual({
        ok: false,
        failure: "failed",
        answer: 1,
      });
      expect(await caller.call("read", async () => 2, { failed: (v: number) => v === 1 })).toEqual({
        ok: true,
        value: 2,
      });
    });

    it("a failed-check that is not a function fails the call without a crash", async () => {
      const { caller } = setup();
      const options = { failed: "unavailable" as unknown as (v: number) => boolean };
      expect(await caller.call("read", async () => 1, options)).toEqual({
        ok: false,
        failure: "failed",
      });
    });
  });

  // Plan #149 E-13: the default clock is monotonic, so a jump of the wall clock
  // neither shortens nor stretches the deadline and the duration stays real.
  describe("the default clock ignores the wall clock", () => {
    const REAL = { ...POLICY, timeoutMs: 2000, downAfter: 9 };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // The wall clock is replaced before the caller exists, so a caller that
    // read `Date.now` would see the jump.
    const jumpingWallClock = () => {
      const real = Date.now.bind(Date);
      const wall = { offset: 0 };
      const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + wall.offset);
      return { wall, restore: () => spy.mockRestore() };
    };

    it("a jump forward does not turn a quick answer into a timeout", async () => {
      const { wall, restore } = jumpingWallClock();
      try {
        const events: ExternalCallEvent[] = [];
        const caller = createExternalCaller("keys", REAL, { onEvent: (e) => events.push(e) });
        const result = await caller.call("sign", async () => {
          wall.offset = 3_600_000;
          return "signature";
        });
        expect(result).toEqual({ ok: true, value: "signature" });
        expect(events[0]?.durationMs).toBeLessThan(1000);
      } finally {
        restore();
      }
    });

    it("a jump backward does not hide the real duration", async () => {
      const { wall, restore } = jumpingWallClock();
      try {
        const events: ExternalCallEvent[] = [];
        const caller = createExternalCaller("keys", REAL, { onEvent: (e) => events.push(e) });
        await caller.call("sign", async () => {
          wall.offset = -3_600_000;
          await wait(30);
          return "signature";
        });
        expect(events[0]?.durationMs).toBeGreaterThanOrEqual(25);
      } finally {
        restore();
      }
    });
  });
});
