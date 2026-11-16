// S-1E-c (DAN-837): one pattern for every outside service. Invented values only.
import { createFakeClock } from "@ductura/test-fakes/clock";
import { describe, expect, it } from "vitest";

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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

  it("drops an answer that arrives after the deadline, whatever the timers did (Codex c.4585086980)", async () => {
    let time = 0;
    const events: ExternalCallEvent[] = [];
    const caller = createExternalCaller(
      "storage",
      { ...POLICY, timeoutMs: 10 },
      {
        now: () => time,
        sleep: () => new Promise(() => {}),
        onEvent: (e) => events.push(e),
      },
    );
    const result = await caller.call("read", async () => {
      time += 40; // synchronous work past the deadline before the answer
      return "late";
    });
    expect(result).toEqual({ ok: false, failure: "timeout" });
    expect(events[0]).toMatchObject({ outcome: "timeout", attempts: 1, durationMs: 40 });
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

  it.each([
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 0],
    ["timeoutMs", 1.5],
    ["retries", -1],
    ["retryDelayMs", Number.POSITIVE_INFINITY],
    ["downAfter", 0],
    ["downForMs", -5],
  ])("refuses a policy with %s = %s", (key, value) => {
    expect(() => createExternalCaller("storage", { ...POLICY, [key]: value })).toThrow(RangeError);
  });

  it("refuses an operation name that is not a plain code", () => {
    const { caller } = setup();
    for (const bad of ["", "send mail", "send\r\n", "send\t", "send ", "send\u007f", "Send"])
      expect(() => caller.call(bad, async () => 1)).toThrow(RangeError);
  });
});
