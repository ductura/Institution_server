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
